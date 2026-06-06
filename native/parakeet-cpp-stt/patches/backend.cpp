#include "backend.hpp"
#include "common.hpp"
#include "ggml_graph.hpp"
#include "model_loader.hpp"

#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"

#include <cassert>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace pk {

namespace {
constexpr size_t kGraphSize = 16384;

struct PendingInput {
    ggml_tensor* tensor;
    const void* host;
    size_t nbytes;
};

struct PendingCapture {
    ggml_tensor* tensor;
    std::vector<float>* dst;
};
} // namespace

struct Backend::Impl {
    std::vector<ggml_backend_t> backends;
    ggml_backend_sched_t sched = nullptr;
    std::vector<PendingInput> pending;
    std::vector<PendingCapture> captures;
};

static thread_local Backend* t_active = nullptr;

Backend::Backend(int n_threads) : impl_(new Impl()) {
    const char* force = std::getenv("PARAKEET_DEVICE");
    const bool force_cpu = force && std::string(force) == "cpu";

    if (!force_cpu) {
        for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
            ggml_backend_dev_t dev = ggml_backend_dev_get(i);
            const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
            if (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
                ggml_backend_t gpu = ggml_backend_dev_init(dev, nullptr);
                if (gpu) {
                    impl_->backends.push_back(gpu);
                    device_name_ = ggml_backend_dev_name(dev);
                    PK_LOG("pk::Backend using GPU device with CPU fallback: %s", device_name_.c_str());
                    break;
                }
            }
        }
    }

    ggml_backend_t cpu = ggml_backend_cpu_init();
    if (cpu) impl_->backends.push_back(cpu);
    if (impl_->backends.empty()) {
        PK_LOG("backend init returned null");
        return;
    }
    if (device_name_.empty()) device_name_ = "cpu";

    impl_->sched = ggml_backend_sched_new(
        impl_->backends.data(), nullptr, static_cast<int>(impl_->backends.size()), kGraphSize, false, true);
    if (!impl_->sched) {
        PK_LOG("ggml_backend_sched_new returned null");
        return;
    }

    set_n_threads(n_threads);
}

Backend::~Backend() {
    if (impl_) {
        if (impl_->sched) ggml_backend_sched_free(impl_->sched);
        for (ggml_backend_t backend : impl_->backends) {
            if (backend) ggml_backend_free(backend);
        }
        delete impl_;
        impl_ = nullptr;
    }
}

void Backend::set_n_threads(int n_threads) {
    n_threads_ = n_threads > 0 ? n_threads : 1;
    if (!impl_) return;
    for (ggml_backend_t backend : impl_->backends) {
        if (backend && ggml_backend_is_cpu(backend)) {
            ggml_backend_cpu_set_n_threads(backend, n_threads_);
        }
    }
}

ggml_backend_t Backend::handle() const {
    return impl_ && !impl_->backends.empty() ? impl_->backends.front() : nullptr;
}

void Backend::register_input(ggml_tensor* t, const void* host, size_t nbytes) {
    impl_->pending.push_back({t, host, nbytes});
}

void Backend::register_capture(ggml_tensor* t, std::vector<float>* dst) {
    impl_->captures.push_back({t, dst});
}

bool Backend::compute(const std::function<ggml_tensor*(ggml_context*)>& build,
                      std::vector<float>& out) {
    if (!impl_ || !impl_->sched) {
        PK_LOG("Backend::compute called on an uninitialised backend scheduler");
        return false;
    }

    struct ggml_init_params params = {
        /* .mem_size   = */ ggml_tensor_overhead() * kGraphSize + ggml_graph_overhead_custom(kGraphSize, false),
        /* .mem_buffer = */ nullptr,
        /* .no_alloc   = */ true,
    };
    struct ggml_context* ctx = ggml_init(params);
    if (!ctx) {
        PK_LOG("Backend::compute: ggml_init failed");
        return false;
    }

    impl_->pending.clear();
    impl_->captures.clear();
    Backend* prev_active = t_active;
    t_active = this;
    struct ggml_tensor* output = build(ctx);
    t_active = prev_active;

    if (!output) {
        PK_LOG("Backend::compute: build() returned null output tensor");
        impl_->pending.clear();
        impl_->captures.clear();
        ggml_free(ctx);
        return false;
    }

    ggml_set_output(output);
    for (const PendingCapture& pc : impl_->captures) ggml_set_output(pc.tensor);

    struct ggml_cgraph* gf = ggml_new_graph_custom(ctx, kGraphSize, false);
    for (const PendingCapture& pc : impl_->captures) ggml_build_forward_expand(gf, pc.tensor);
    ggml_build_forward_expand(gf, output);

    ggml_backend_sched_reset(impl_->sched);
    if (!ggml_backend_sched_alloc_graph(impl_->sched, gf)) {
        PK_LOG("Backend::compute: ggml_backend_sched_alloc_graph failed");
        impl_->pending.clear();
        impl_->captures.clear();
        ggml_free(ctx);
        return false;
    }

    for (const PendingInput& pi : impl_->pending) {
        ggml_backend_tensor_set(pi.tensor, pi.host, 0, pi.nbytes);
    }
    impl_->pending.clear();

    enum ggml_status status = ggml_backend_sched_graph_compute(impl_->sched, gf);
    if (status != GGML_STATUS_SUCCESS) {
        PK_LOG("Backend::compute: ggml_backend_sched_graph_compute failed (status=%d)", static_cast<int>(status));
        impl_->captures.clear();
        ggml_free(ctx);
        return false;
    }

    for (const PendingCapture& pc : impl_->captures) {
        size_t cn = static_cast<size_t>(ggml_nelements(pc.tensor));
        pc.dst->resize(cn);
        ggml_backend_tensor_get(pc.tensor, pc.dst->data(), 0, cn * sizeof(float));
    }
    impl_->captures.clear();

    size_t n = static_cast<size_t>(ggml_nelements(output));
    out.resize(n);
    ggml_backend_tensor_get(output, out.data(), 0, n * sizeof(float));

    ggml_free(ctx);
    return true;
}

void add_graph_input(ggml_tensor* t, const void* host, size_t nbytes) {
    GGML_ASSERT(t_active != nullptr && "add_graph_input called outside a Backend::compute build lambda");
    ggml_set_input(t);
    t_active->register_input(t, host, nbytes);
}

ggml_tensor* graph_input_tensor(ggml_context* ctx, int type, int n_dims,
                                const int64_t* ne, const void* host,
                                size_t nbytes) {
    ggml_tensor* t = ggml_new_tensor(ctx, static_cast<ggml_type>(type), n_dims, ne);
    add_graph_input(t, host, nbytes);
    return t;
}

void capture_graph_output(ggml_tensor* t, std::vector<float>* dst) {
    GGML_ASSERT(t_active != nullptr && "capture_graph_output called outside a Backend::compute build lambda");
    t_active->register_capture(t, dst);
}

void ensure_weights_realized(const ModelLoader& ml) {
    if (ml.weights_realized()) return;
    ModelLoader& mut = const_cast<ModelLoader&>(ml);
    mut.realize_weights(global_backend().handle());
}

ggml_tensor* clone_weight(ggml_context* /*ctx*/, const ModelLoader& ml,
                          const char* name) {
    ensure_weights_realized(ml);
    ggml_tensor* src = ml.tensor(name);
    assert(src && "missing tensor");
    return src;
}

ggml_tensor* clone_weight_opt(ggml_context* ctx, const ModelLoader& ml,
                              const char* name) {
    if (!ml.tensor(name)) return nullptr;
    return clone_weight(ctx, ml, name);
}

void weight_to_host_f32(const ModelLoader& ml, const char* name, std::vector<float>& out) {
    ensure_weights_realized(ml);
    ggml_tensor* t = ml.tensor(name);
    GGML_ASSERT(t && "weight_to_host_f32: missing tensor");
    GGML_ASSERT(t->type == GGML_TYPE_F32 && "weight_to_host_f32: tensor not f32");
    out.resize(static_cast<size_t>(ggml_nelements(t)));
    ggml_backend_tensor_get(t, out.data(), 0, ggml_nbytes(t));
}

} // namespace pk
