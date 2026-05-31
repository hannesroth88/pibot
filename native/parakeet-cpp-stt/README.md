# parakeet.cpp STT worker

Native C++ STT worker for pibot using `mudler/parakeet.cpp` GGUF models plus whisper.cpp's GGML Silero VAD.

It reads length-prefixed 16-bit little-endian mono PCM frames from stdin and emits newline-delimited JSON events compatible with the existing STT service.

## Build

```bash
npm run build:stt-parakeet-cpp
```

The CMake project fetches `mudler/parakeet.cpp` and `ggml-org/whisper.cpp`, then builds:

```text
native/parakeet-cpp-stt/build/parakeet-cpp-stt-worker
```

## Run from the app

```bash
STT_WORKER=parakeet-cpp npm run dev
```

By default the TypeScript server downloads:

```text
~/models/parakeet-cpp-gguf/tdt-0.6b-v3-q8_0.gguf
~/models/whisper-vad/ggml-silero-v6.2.0.bin
```

Override with:

```bash
PARAKEET_CPP_MODEL_PATH=/path/to/model.gguf SILERO_VAD_GGML_MODEL_PATH=/path/to/ggml-silero.bin STT_WORKER=parakeet-cpp npm run dev
```

or:

```bash
PARAKEET_CPP_MODEL_FILE=realtime_eou_120m-v1-q8_0.gguf STT_WORKER=parakeet-cpp npm run dev
```
