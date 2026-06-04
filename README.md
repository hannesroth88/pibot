# Pipi

Pipi is a smartphone robot that can talk, remember things, take photos, and drive around when mounted on an [Octobot](https://robo.silverlit.com/products/octobot/).

## Requirements

- Apple Silicon Mac with at least 32 GB unified memory.
- The default local model set needs about 8-10 GB of unified memory at runtime.
- Node.js 22+, Rust, Xcode command line tools, Xcode Metal Toolchain, CMake, pkg-config, Opus, and `tar`.

Install native build prerequisites:

```bash
brew install cmake pkg-config opus
xcodebuild -downloadComponent MetalToolchain
```

## Setup

```bash
npm install --ignore-scripts
npm run submodules
npm run build:native
npm run dev
```

Open:

```text
http://localhost:8010
```

For phone access, expose port `8010` over HTTPS, for example with ngrok.

## Models

Pipi runs local LLM, STT, and TTS models. Missing default models are downloaded automatically on startup.

- LLM default: Gemma 4 26B A4B MoE Q4 via llama.cpp.
  - Model: `ggml-org/gemma-4-26B-A4B-it-GGUF`
  - Downloaded into: `~/models/gemma-4-26b-a4b-it`
  - Pipi also downloads a pinned llama.cpp release into `~/.cache/pibot/llama.cpp`.
  - Use `LOCAL_LLM=gemma12b npm run dev` for Gemma 4 12B IT Q4 from `unsloth/gemma-4-12b-it-GGUF`, downloaded into `~/models/gemma-4-12b-it`.

- STT default: native `parakeet.cpp` GGUF worker with whisper.cpp GGML Silero VAD.
  - Build with `npm run build:stt-parakeet-cpp`.
  - Model: `mudler/parakeet-cpp-gguf/tdt-0.6b-v3-q8_0.gguf`.
  - Downloaded into: `~/models/parakeet-cpp-gguf/tdt-0.6b-v3-q8_0.gguf`.
  - VAD model: `ggml-org/whisper-vad/ggml-silero-v6.2.0.bin`.
  - Downloaded into: `~/models/whisper-vad/ggml-silero-v6.2.0.bin`.
  - Override with `PARAKEET_CPP_MODEL_PATH`/`PARAKEET_CPP_MODEL_FILE` and `SILERO_VAD_GGML_MODEL_PATH`/`SILERO_VAD_GGML_MODEL_FILE`.

- TTS: Qwen3-TTS 0.6B Base 6-bit MLX.
  - Model: `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit`
  - Downloaded into: `~/models/qwen3-tts-12hz-0.6b-base-6bit`

## Commands

```bash
npm run dev             # start the development server
npm run build:native    # build STT and TTS native workers
npm run build:stt-parakeet-cpp # build the native parakeet.cpp STT worker
npm run build:tts-rust  # build only the Rust Qwen3-TTS worker
npm run check           # format/lint/typecheck/build client
npm run bench:stt       # benchmark STT worker
npm run bench:tts       # benchmark TTS worker
npm run bench:llm       # benchmark local LLM server
```
