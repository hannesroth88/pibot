# Phone Robot Agent Demo

Android phone as robot face/camera/mic/speaker; Node server runs the LLM agent; FT232H/WebUSB motor control is separate for now.

## Run web demo

Prerequisites:

- Node.js 22+
- `uv` available on `PATH` so the server can spawn local speech sidecars with `uvx`:
  - Pocket TTS for German TTS
  - Parakeet MLX + Silero VAD for local STT

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:8010
```

For phone access, expose port `8010` via ngrok HTTPS.

## STT/TTS direction

Browser Web Speech on Android is unreliable: it ends sessions after ~5s and fights TTS/audio focus.

Current direction:

- STT: browser audio is streamed as 16 kHz PCM to the Node server. The server auto-starts `scripts/parakeet-stt-worker.py` through `uvx --with parakeet-mlx --with silero-vad`, uses Silero VAD for endpointing, then runs Parakeet batch transcription with auto language detection. The Parakeet v3 model supports German and is CC-BY-4.0.
- TTS: switchable in the UI between ElevenLabs and Kyutai Pocket TTS. ElevenLabs defaults to the account voice `pibot` (`r1pUec9VJPfpUaMUuRX2`) using model `eleven_v3`. Pocket TTS auto-starts with `uvx pocket-tts serve --language german --host 127.0.0.1 --port 8020` if selected and nothing is already listening. Both providers stream audio to the phone.

Whisper/WhisperLiveKit experiments were removed.

## Current tools

- `move_forward`
- `turn_left` / counter-clockwise rotate
- `stop`
- `take_photo`
- `memory`
