#include "parakeet_capi.h"
#include "ggml_graph.hpp"
#include "whisper.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <exception>
#include <fstream>
#include <iostream>
#include <numeric>
#include <string>
#include <vector>

static constexpr size_t SAMPLE_RATE = 16000;
static constexpr size_t VAD_CHUNK_FRAMES = 512;
static constexpr size_t VAD_CHUNK_MS = 32;

struct Config {
    std::string model_path;
    std::string vad_model_path;
    float vad_threshold = 0.45f;
    size_t min_silence_ms = 800;
    size_t speech_pad_ms = 250;
    size_t preroll_ms = 1800;
    size_t min_utterance_ms = 450;
    size_t interim_interval_ms = 250;
    size_t interim_min_audio_ms = 300;
    size_t interim_window_ms = 4000;
    float energy_gate = 0.002f;
};

static size_t env_size(const char* name, size_t fallback) {
    const char* value = std::getenv(name);
    return value ? static_cast<size_t>(std::strtoull(value, nullptr, 10)) : fallback;
}

static float env_float(const char* name, float fallback) {
    const char* value = std::getenv(name);
    return value ? std::strtof(value, nullptr) : fallback;
}

static std::string json_escape(const std::string& value) {
    std::string out;
    for (char c : value) {
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c == '\n') out += "\\n";
        else if (c == '\r') out += "\\r";
        else if (c == '\t') out += "\\t";
        else out += c;
    }
    return out;
}

class SileroVad {
public:
    explicit SileroVad(const std::string& model_path) {
        whisper_vad_context_params params = whisper_vad_default_context_params();
        params.n_threads = 1;
        params.use_gpu = false;
        ctx_ = whisper_vad_init_from_file_with_params(model_path.c_str(), params);
        if (!ctx_) throw std::runtime_error("failed to load whisper.cpp Silero VAD model: " + model_path);
    }

    ~SileroVad() { whisper_vad_free(ctx_); }

    void reset() { whisper_vad_reset_state(ctx_); }

    float predict(const std::vector<float>& chunk) {
        if (!whisper_vad_detect_speech_no_reset(ctx_, chunk.data(), static_cast<int>(chunk.size()))) {
            return 0.0f;
        }
        int n = whisper_vad_n_probs(ctx_);
        float* probs = whisper_vad_probs(ctx_);
        return n > 0 ? probs[n - 1] : 0.0f;
    }

private:
    whisper_vad_context* ctx_ = nullptr;
};

static bool read_frame(std::vector<float>& out) {
    uint32_t bytes = 0;
    if (!std::cin.read(reinterpret_cast<char*>(&bytes), sizeof(bytes))) return false;
    std::vector<int16_t> pcm(bytes / 2);
    if (bytes > 0 && !std::cin.read(reinterpret_cast<char*>(pcm.data()), bytes)) throw std::runtime_error("unexpected EOF in PCM frame");
    out.resize(pcm.size());
    for (size_t i = 0; i < pcm.size(); ++i) out[i] = static_cast<float>(pcm[i]) / 32768.0f;
    return true;
}

static float rms(const std::vector<float>& chunk) {
    float sum = 0.0f;
    for (float sample : chunk) sum += sample * sample;
    return std::sqrt(sum / static_cast<float>(chunk.size()));
}

static void whisper_log_silent(ggml_log_level, const char*, void*) {}

static std::string transcribe(parakeet_ctx* model, const std::vector<float>& audio) {
    char* raw = parakeet_capi_transcribe_pcm(model, audio.data(), static_cast<int>(audio.size()), SAMPLE_RATE, 0);
    if (!raw) throw std::runtime_error(parakeet_capi_last_error(model));
    std::string text(raw);
    parakeet_capi_free_string(raw);
    return text;
}

int main(int argc, char** argv) {
    try {
        Config cfg;
        const char* env_model = std::getenv("PARAKEET_CPP_MODEL_PATH");
        const char* env_vad_model = std::getenv("SILERO_VAD_GGML_MODEL_PATH");
        if (argc > 1) cfg.model_path = argv[1];
        else if (env_model) cfg.model_path = env_model;
        else throw std::runtime_error("missing GGUF model path argument or PARAKEET_CPP_MODEL_PATH");
        if (argc > 2) cfg.vad_model_path = argv[2];
        else if (env_vad_model) cfg.vad_model_path = env_vad_model;
        else throw std::runtime_error("missing Silero VAD GGML model path argument or SILERO_VAD_GGML_MODEL_PATH");
        cfg.vad_threshold = env_float("PARAKEET_VAD_THRESHOLD", cfg.vad_threshold);
        cfg.min_silence_ms = env_size("PARAKEET_MIN_SILENCE_MS", cfg.min_silence_ms);
        cfg.speech_pad_ms = env_size("PARAKEET_SPEECH_PAD_MS", cfg.speech_pad_ms);
        cfg.preroll_ms = env_size("PARAKEET_PREROLL_MS", cfg.preroll_ms);
        cfg.min_utterance_ms = env_size("PARAKEET_MIN_UTTERANCE_MS", cfg.min_utterance_ms);
        cfg.interim_interval_ms = env_size("PARAKEET_INTERIM_INTERVAL_MS", cfg.interim_interval_ms);
        cfg.interim_min_audio_ms = env_size("PARAKEET_INTERIM_MIN_AUDIO_MS", cfg.interim_min_audio_ms);
        cfg.interim_window_ms = env_size("PARAKEET_INTERIM_WINDOW_MS", cfg.interim_window_ms);
        cfg.energy_gate = env_float("PARAKEET_ENERGY_GATE", cfg.energy_gate);

        whisper_log_set(whisper_log_silent, nullptr);

        std::cerr << "loading parakeet.cpp model: " << cfg.model_path << "\n";
        parakeet_ctx* model = parakeet_capi_load(cfg.model_path.c_str());
        if (!model) throw std::runtime_error("failed to load parakeet.cpp model");
        std::cerr << "loading whisper.cpp Silero VAD model: " << cfg.vad_model_path << "\n";
        SileroVad vad(cfg.vad_model_path);

        std::cout << "{\"type\":\"ready\",\"sampleRate\":16000,\"vadChunkMs\":32,\"vadThreshold\":" << cfg.vad_threshold
                  << ",\"minSilenceMs\":" << cfg.min_silence_ms << ",\"speechPadMs\":" << cfg.speech_pad_ms
                  << ",\"prerollMs\":" << cfg.preroll_ms << ",\"interimIntervalMs\":" << cfg.interim_interval_ms
                  << ",\"interimMinAudioMs\":" << cfg.interim_min_audio_ms << ",\"interimWindowMs\":" << cfg.interim_window_ms
                  << ",\"energyGate\":" << cfg.energy_gate << "}" << std::endl;

        std::vector<float> pending;
        std::deque<std::vector<float>> preroll;
        std::vector<std::vector<float>> utterance_chunks;
        bool in_utterance = false;
        size_t utterance_index = 0;
        size_t silence_ms = 0;
        size_t last_interim_ms = 0;
        const size_t preroll_chunks = std::max<size_t>(1, cfg.preroll_ms / VAD_CHUNK_MS);
        const size_t min_frames = std::max<size_t>(1, SAMPLE_RATE * cfg.min_utterance_ms / 1000);
        const size_t interim_min_frames = std::max<size_t>(1, SAMPLE_RATE * cfg.interim_min_audio_ms / 1000);
        const size_t interim_window_frames = std::max<size_t>(1, SAMPLE_RATE * cfg.interim_window_ms / 1000);
        auto started = std::chrono::steady_clock::now();

        std::vector<float> frame;
        while (read_frame(frame)) {
            pending.insert(pending.end(), frame.begin(), frame.end());
            while (pending.size() >= VAD_CHUNK_FRAMES) {
                std::vector<float> chunk(pending.begin(), pending.begin() + VAD_CHUNK_FRAMES);
                pending.erase(pending.begin(), pending.begin() + VAD_CHUNK_FRAMES);
                float probability = rms(chunk) >= cfg.energy_gate ? vad.predict(chunk) : 0.0f;
                bool is_speech = probability >= cfg.vad_threshold;
                preroll.push_back(chunk);
                while (preroll.size() > preroll_chunks) preroll.pop_front();
                if (!in_utterance && is_speech) {
                    in_utterance = true;
                    utterance_index++;
                    utterance_chunks.assign(preroll.begin(), preroll.end());
                    silence_ms = 0;
                    last_interim_ms = 0;
                    double t = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
                    std::cout << "{\"type\":\"speech_start\",\"index\":" << utterance_index << ",\"time\":" << t << "}" << std::endl;
                    continue;
                }
                if (!in_utterance) continue;
                utterance_chunks.push_back(chunk);
                silence_ms = is_speech ? 0 : silence_ms + VAD_CHUNK_MS;
                size_t audio_frames = 0;
                for (const auto& c : utterance_chunks) audio_frames += c.size();
                size_t audio_ms = audio_frames * 1000 / SAMPLE_RATE;
                if (cfg.interim_interval_ms > 0 && audio_frames >= interim_min_frames && audio_ms - last_interim_ms >= cfg.interim_interval_ms) {
                    last_interim_ms = audio_ms;
                }
                if (silence_ms >= cfg.min_silence_ms) {
                    std::vector<float> audio;
                    audio.reserve(audio_frames);
                    for (const auto& c : utterance_chunks) audio.insert(audio.end(), c.begin(), c.end());
                    double duration = static_cast<double>(audio.size()) / SAMPLE_RATE;
                    if (audio.size() < min_frames) {
                        std::cout << "{\"type\":\"speech_drop\",\"index\":" << utterance_index << ",\"duration\":" << duration << ",\"reason\":\"too_short\"}" << std::endl;
                    } else {
                        std::cout << "{\"type\":\"speech_end\",\"index\":" << utterance_index << ",\"duration\":" << duration << "}" << std::endl;
                        auto decode_start = std::chrono::steady_clock::now();
                        std::string text = transcribe(model, audio);
                        auto decode_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - decode_start).count();
                        std::cout << "{\"type\":\"final\",\"index\":" << utterance_index << ",\"text\":\"" << json_escape(text) << "\",\"duration\":" << duration << ",\"decodeMs\":" << decode_ms << "}" << std::endl;
                    }
                    in_utterance = false;
                    utterance_chunks.clear();
                    preroll.clear();
                    vad.reset();
                }
            }
        }
        parakeet_capi_free(model);
        pk::shutdown_backend();
        return 0;
    } catch (const std::exception& e) {
		pk::shutdown_backend();
        std::cout << "{\"type\":\"error\",\"message\":\"" << json_escape(e.what()) << "\"}" << std::endl;
        return 1;
    }
}
