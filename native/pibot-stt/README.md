# pibot STT worker

Native STT worker for pibot.

It reads length-prefixed 16-bit little-endian mono PCM frames from stdin and emits the same newline-delimited JSON events as the Python worker.

## Build

```bash
npm run build:stt-rust
```

## Run from the app

The server starts this worker automatically.

By default the worker expects the Parakeet TDT int8 ONNX files in:

```text
~/models/parakeet-tdt-0.6b-v3-onnx-int8/
  encoder-model.int8.onnx
  decoder_joint-model.int8.onnx
  vocab.txt
```

Override with:

```bash
PARAKEET_TDT_MODEL_DIR=/path/to/model npm run dev
```

CPU-related knobs:

```bash
PARAKEET_ENERGY_GATE=0.002          # skip Silero VAD on near-silent chunks
PARAKEET_INTERIM_INTERVAL_MS=0      # 0 disables repeated interim decodes while speaking
```

## Packaging notes

The worker is a native executable. ONNX Runtime provisioning is handled by the `ort`/`ort-sys` build, which downloads and links the matching runtime for the target platform. On the current macOS arm64 build, `otool -L target/release/pibot-stt-worker` shows no external `libonnxruntime.dylib` dependency; system frameworks are sufficient.

The Parakeet model directory remains external and is downloaded by the TypeScript server on startup.

The embedded VAD model and local `voice_activity_detector` crate are adapted from `nkeenan38/voice_activity_detector` to use the same `ort` version as `parakeet-rs`.
