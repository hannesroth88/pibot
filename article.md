---
title: yet another shitty robot
date: 2026-06-27
excerpt: "Extending a Toy-Robot together with my kids using a Speech Pipeline with (STT-LLM-TTS) with a phone and making it use tools (motor, spotify, homeassistant and so on)."
tags: [Robot, TTS, LLM, TTS, ESP32, VAD, Python, PI-Agent]
---

heard about Mario Zechners Robot build https://mariozechner.at/posts/2026-05-30-shitty-robot/
have also 2 kids and watned to have a fun project and of course learn more about intersection of robot and AI also learn about model inteference quantization and optimize on my hardware setup.
For robot live interaction its super important to have that human interaction. Listen when needed, answer when human is done speaking and so on.

Ordered 2 octobots, wnated to use my old Pixel smartphone. esp32 and a motor driver for the one motor in the octobot.

## Text-to-speech: making it fast and making it sound like *my* robot

The voice was the first thing that really annoyed me. I had Qwen3-TTS running,
but two problems: it took ~2 minutes before I heard anything, and it sounded
bad.

Turned out I was on the PyTorch/transformers path of Qwen3-TTS. On my M1 that
runs float32 on the Metal/MPS backend at a real-time factor of about 4 - meaning
4 seconds of compute for every 1 second of audio. I measured it: a 10s clip took
40s, plus ~10s to load the model every single run. On top of that I was running
the canned "ryan" speaker through a homemade robot DSP effect (bitcrush, ring
mod, the whole "tiny robot" preset), which is what made it sound rough.

Then I looked at how Mario actually did it in pibot. He does *not* use the slow
PyTorch path and he does *not* fake the robot sound with DSP. Instead he uses the
Qwen3-TTS **Base** model, which can clone a voice in-context (ICL) from a short
reference clip plus its transcript, and he runs it through native, quantized
runtimes (MLX 6-bit on Apple Silicon, or a C++/Metal GGUF build). His reference
voice is a clip he generated on ElevenLabs.

So I did the same thing, the Python/MLX variant:

- Made my own reference voice on elevenlabs.io (a friendly small teaching robot),
  exported the mp3 + the exact transcript.
- Converted it to a clean 24 kHz mono wav with ffmpeg.
- Installed `mlx-audio` (Apple-native, runs on Metal).
- Loaded the 6-bit Base model `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit` and
  voice-cloned my reference clip with `model.generate(text=..., ref_audio=...,
  ref_text=...)`.
- Dropped the robot DSP entirely - the voice now comes straight from my
  reference sample.

The difference: real-time factor went from ~4 down to **under 1 on longer text**
(0.85), roughly 4-5x faster, and it actually sounds like the voice I picked
instead of a bitcrushed "ryan". Soundcheck successful.

In the repo this is a new backend (`src/tts/qwen3_mlx_tts.py`) selected with
`TTS_BACKEND=qwen3-mlx`; the reference clip + transcript live in `voices/sample/`
and are wired through config (`QWEN3_REF_AUDIO` / `QWEN3_REF_TEXT_FILE`). The old
PyTorch path is still there for x86/CUDA fleet hosts.

### Two things that confused me

**"Why does it download something every time?"** Every run prints
`Fetching 12 files...` and a download bar. It's not actually re-downloading - the
weights are cached under `~/.cache/huggingface`. That line is Hugging Face
*resolving/verifying* the snapshot against the cache (notice `84449 it/s` and
`Download complete: 0.00B` - nothing is transferred). To skip the network check
entirely and force fully offline use, set `HF_HUB_OFFLINE=1` (and
`TRANSFORMERS_OFFLINE=1`).

**"The first short reply ("Hallo") I couldn't really hear."** Two reasons.
First, `tools/smoke.py` is a one-shot process: it loads the whole TTS model from
scratch every call (~7s) before it can speak, which is why a tiny "Hallo!" shows
`tts 8873ms` - that's mostly model load, not synthesis. Second, very short
utterances have a high fixed overhead (RTF ~1.3 for one word vs 0.85 for a full
sentence) and the clip is so short it's easy to miss.

Both of these go away with the client/server split (Phase 1): the TTS service
loads the model **once** at startup and stays resident, so per-turn latency is
just generation, and the persistent worker can stream audio chunks so you hear
the first words before the whole clip is done. So yes - this is a one-shot-CLI
artifact, not a real pipeline cost.

## Improvement: stream Qwen3-TTS audio instead of buffering

**Observed:** the 2026-06-17 benchmark run with a long German prompt (~70 words)
recorded **17,162 ms TTS** and a **20,320 ms total**. The model itself is fast
(RTF < 1 on Apple Silicon), but `qwen3_mlx_tts.py` does:

```python
results = list(model.generate(...))   # ← collects ALL chunks first
samples, sr = _collect_audio(results) # ← then writes one big WAV
```

That `list()` call is the problem — it blocks until the full audio is ready
before any sound plays. For a 70-word sentence that means ~17 s of silence
followed by the whole clip at once.

**Why Qwen3-TTS is especially good for robots:** `model.generate()` is already a
generator that yields audio chunks as they are synthesized. Streaming means the
pipeline can hand the first chunk (~100–200 ms of audio) to the speaker while
the rest is still being generated. The robot starts speaking almost immediately —
which is exactly the low-latency feel that makes a voice assistant feel alive.

**What needs to change:**

1. **`Qwen3MlxTTS`** — add a `synthesize_stream()` generator that yields
   `(samples: np.ndarray, sr: int)` chunks directly from `model.generate()`,
   instead of collecting them all with `list()`.
2. **`Pipeline.speak()`** — detect if the TTS backend supports streaming and, if
   so, start piping chunks to the audio output (sounddevice / pyaudio) while
   remaining chunks arrive.
3. **Benchmark** — add a new row with `tts_config = "qwen3-mlx (streaming)"` to
   compare first-audio latency vs the buffered 17 s baseline.

**Expected improvement:** first audio in **~1–2 s** (one synthesized chunk)
instead of 17 s, with the rest of the sentence following seamlessly. TOTAL
could drop from ~20 s to ~5 s for the same long German prompt.

**Tracked as:** Phase 1 / TTS streaming — prerequisite for the robot feeling
responsive. Implement alongside the client/server split so the TTS service stays
resident and streams over the wire.

## Phase 1 — the service split (done)

The Phase-0 loop was synchronous: record → transcribe → wait for the *whole* LLM
reply → synthesize the *whole* reply → play. Phase 1 rebuilds that into an
event-driven orchestrator with a transport seam, and — the big UX lever — it
overlaps the LLM and the TTS.

**Sentence chunker.** `src/text/sentence_chunker.py` turns the LLM token stream
into complete sentences as soon as they form (`push(delta) -> [sentences]`,
`flush() -> tail`). It's careful about German abbreviations ("z. B.") and decimals
("3.14") so it doesn't cut mid-token. 8 unit tests cover it.

**Streaming TTS.** `src/tts/streaming.py` defines a `StreamingTTS` protocol and a
`SentenceStreamingTTS` adapter that wraps any non-streaming engine (say, Piper,
Kokoro): it synthesizes one wav per sentence and yields each as it's ready.
Native-streaming engines (Qwen3) can plug straight in later.

**Event-driven orchestrator.** `src/orchestrator.py` replaces the blocking
`Pipeline`. It runs a phase state machine (`inactive → listening → thinking →
speaking`) and emits events (`phase`, `assistant_delta`, `tts_audio`, `latency`,
`error`) to any number of subscribers. Internally the LLM streams on its own
thread while a consumer synthesizes + plays each sentence as it arrives — so
**LLM timing stays pure** (honest benchmark numbers) and audio starts early.

**Control server.** `src/server/app.py` is a stdlib-only HTTP + WebSocket server
(hand-rolled WS framing, no aiohttp/websockets dependency). The CLI is one client
of the orchestrator; a tiny web face (`src/server/static/index.html`) is another.
Send `{type:"prompt"}` over the WS, receive the event stream live.

**Network backends (the Phase 2 seam, landed early).** `src/llm/http_llm.py`
(Ollama or OpenAI-compatible) and `src/stt/http_stt.py` (multipart POST) let any
stage move to another host by flipping env — no orchestrator change. Proven
locally: `LLM_BACKEND=http LLM_HTTP_URL=…` against Ollama worked with zero code
change.

### The headline metric: `first_audio_ms`

New benchmark column. With Piper streaming a 3-sentence German reply:

| metric | value |
|--------|-------|
| STT | 451 ms |
| LLM (full) | 2297 ms |
| TTS (full, 3 sentences) | 6841 ms |
| **first audio** | **3332 ms** |
| TOTAL (full turn) | 9589 ms |

Without streaming the user waits for the whole turn — ~9.6 s — before hearing a
word. With streaming the first sentence plays at **~3.3 s**, a **~60 % cut in
perceived latency**. The win grows with reply length (more sentences = earlier
first audio relative to the total). The strict `first_audio < llm` holds for
multi-sentence replies whose opening sentence is short; either way the
perceived-latency-vs-total win is the real story.

## Phase 2 — fleet distribution (foundation laid, hardware pending)

Phase 2 makes placement real: LLM on the on-demand Gaming-PC GPU, always-on
services on the NUC, with graceful fallback. The code that doesn't need the other
hosts is in and tested on the Mac; the actual cross-host benchmark runs wait on
bringing the NUC + GPU box online.

**Routed LLM + Wake-on-LAN.** `src/llm/routed_llm.py` composes a remote-GPU
primary with a local fallback behind the same `stream()` interface
(`LLM_BACKEND=routed`). On a request it checks the primary port; if closed it
sends a WoL magic packet (`src/net/wol.py`) and polls `/api/tags` until the box
is up (logged as a COLD run); if it doesn't wake in time it downgrades to the
local small model and notes the downgrade. An idle timer suspends the GPU box
over SSH. Proven locally: with an unreachable primary the turn completed on the
local fallback, emitting `downgrade -> local fallback llama3.2` — **orchestrator
unchanged**.

**Standalone services.** `services/stt_server` and `services/tts_server` run the
STT/TTS backends as HTTP services so they can live on the NUC. The STT service
was validated end-to-end on the Mac: `http_stt` → `stt_server` → faster-whisper
round-tripped "Hallo, das ist ein Test." correctly. (Multipart parsing is
hand-rolled to avoid the deprecated `cgi` module — future-proof for Python 3.13.)

**Presets.** `src/presets.py` declares 4 host layouts (mac-local, nuc-gpu,
nuc-only, distributed-stt-tts); `python -m src.presets <key>` prints the matching
`.env`. Real MACs/IPs get filled in as hosts come online.

**Still pending (needs the hardware):** actually waking the Gaming PC, and the
side-by-side fleet benchmark rows (Mac-only vs NUC+GPU warm/cold vs NUC-only).
The WoL packet builder is unit-tested; the wake itself waits on a configured MAC
and a box that's plugged in.

## The phone is the face, the ESP32 is the body

A design fork worth recording. The plan (Phase 4) imagined an **ESP32-S3-Box**
as the audio front-end. But the board I actually have is a bare
**ESP32-S3-DevKitC-1 (N16R8)** — WiFi, 36 GPIO, one WS2812 RGB LED on GPIO48, and
**no mic, speaker, camera, or display**. Meanwhile the robot is "a small robot
with a smartphone" (pibot's framing) and I have a **Pixel 3** with all of that I/O
plus a great screen.

So the roles invert from the naive "ESP32 = edge device" reading:

- **Phone = front-end + caller.** It runs the web-face in the browser, captures
  the mic, plays TTS, shows the camera, renders the animated avatar, and is the
  one that *calls the pipeline* (over the control-server WebSocket).
- **ESP32 = body.** It's a *second subscriber* to the same WebSocket. It never
  calls the pipeline; it reacts to `phase` events (RGB LED now, motors later).
- **Fleet = brains.** STT → LLM → TTS + the broadcast hub.

The one change this forced: the control server used to give each WS connection
its own orchestrator, so the phone's turn was invisible to the ESP32. It's now
**one shared orchestrator + a broadcast hub** — any client can send input, and
*every* client (phone face + ESP32 body) receives the same event stream. One
robot, one face, one body, one pipeline.

### The avatar (phone web-face)

An SVG robot face — two eyes with pupils + glowing irises, two eyebrows, and a
mouth — rigged in `src/server/static/face.js`. A tiny tween engine eases between
per-phase expression targets, with idle micro-behaviours (blink every few
seconds, subtle pupil drift) so it feels alive. Phase → expression:

| Phase | Eyes | Brows | Mouth |
|-------|------|-------|-------|
| inactive | half-lidded | neutral | gentle smile |
| listening | open | raised | friendly smile |
| thinking | look up/side | one raised | small, focused |
| speaking | open, lively | neutral | **animated talking** + smile |
| error | narrowed | furrowed | concerned frown |

The mouth is a quadratic curve whose middle dips down for a smile or up for a
frown; talking is a `speaking`-gated oscillation plus a per-`tts_audio`-chunk
twitch. `app.js` is the WS client: it maps events to expressions, queues + plays
TTS segments in order, records mic audio via `MediaRecorder` and ships the blob
over the WS as a binary frame (the server ffmpeg-converts → STT → turn), and has
an optional local webcam preview (a hook for future vision).

### Kiosk on the phone

To make the Pixel behave like a robot face and not a browser tab: a PWA manifest
(`display: fullscreen`) so **Add to Home screen** launches it chrome-less, a
`navigator.wakeLock` so the screen never sleeps while it's up, and tap-the-face
→ `requestFullscreen`. First mic + webcam test on real hardware: the avatar
heard the prompt, answered, and the camera preview worked.

**Secure-context gotcha.** `getUserMedia` (mic + camera) only works in a *secure
context*: `localhost` is exempt, but a LAN IP over plain HTTP is **not** — so the
phone at `http://<mac-ip>:8010` gets the mic blocked (the browser reports it as a
generic "denied"). Two fixes landed: the client now names the real cause
(permission vs insecure-origin vs no-device vs busy) instead of a blanket
message, and the server gained optional **HTTPS** (`SERVER_TLS=1`) with an
auto-generated self-signed cert. Over TLS the page is a secure context, mic and
camera work from the phone, and the WebSocket auto-upgrades to `wss://`. On the
Mac itself the cause is usually OS-level: Chrome needs Microphone access in
macOS *System Settings ▸ Privacy & Security*.

**The segfault after one turn.** Driving the live server with Qwen3-TTS (MLX)
crashed the process — a `Segmentation fault: 11`, no Python traceback — right
after a successful turn or two. The cause: the orchestrator synthesizes on a
fresh per-turn worker thread, and **MLX/Metal is not thread-safe**, so touching
the GPU from a different thread each turn eventually faults natively. `nohup`
buffering had been hiding the evidence, so the first fix was a debug launcher
(now `cli/robot start`, formerly `tools/dev_server.sh`) that runs unbuffered with
`PYTHONFAULTHANDLER=1` and tees
live logs — which is what surfaced the faulthandler dump. The same MLX path is
also the slow one (~15s cold, ~2.7s/turn warm). Switching the live server to
**Piper** (a subprocess: thread-safe + fast) fixed both at once — turns dropped
to ~1.4–1.6s and the server survived repeated turns. Qwen3-TTS stays the quality
voice for offline generation; bringing it back to the live loop needs a single
dedicated TTS thread so Metal is always touched from the same thread.

### Borrowing badlogic's worker pattern

Mario Zechner's [pibot](https://github.com/badlogic/pibot) solved this exact
problem, and reading his code + [write-up](https://mariozechner.at/posts/2026-05-30-shitty-robot/)
confirmed the fix. His architecture is the one we converged on independently:
the server is the brain (STT/LLM/TTS/agent), the phone is a "dumb renderer"
(mic up, audio down, tools) — he even *skipped the ESP32* and drives the motor
from the phone over USB. The key move: STT and TTS each run as a **separate,
long-lived worker *process*** that the server talks to over a binary stdio
protocol, streaming audio. The model loads once and stays warm; a worker crash
fails one turn and respawns instead of taking down the server.

And the language question answers itself: his Rust TTS worker uses **MLX-C** —
the *same* Metal kernels as Python MLX (he even had to patch an MLX Metal-kernel
bug himself). It's *parity* performance "without all the Python gunk"; his
*default* worker is actually C++/GGML because it's cross-platform (Metal +
Vulkan). So Rust isn't better at Metal — the win is **process isolation**, not
the language.

So I built the same thing in Python. `services/tts_worker/worker.py` is a
persistent process that loads the engine once and synthesizes **on its main
thread only** (no cross-thread Metal), with stdout reserved as a clean JSON
protocol channel (an fd-dup forces all model chatter to stderr). `WorkerTTS`
(`src/tts/worker_tts.py`) is the client: it implements the same `synthesize()`
protocol so the orchestrator is unchanged, spawns the worker, auto-restarts it on
crash, and is selected with `TTS_BACKEND=worker` (the DSP effect still wraps it
in-process; the worker runs raw). The control server pre-warms it at startup.

Result, driving the qwen3 voice that used to segfault: the server **survived
repeated turns**, the worker stayed warm as one process, and with pre-warm the
first turn dropped from ~40s cold to ~5.7s, then ~2.9s warm. Same cloned voice,
no crash. (Piper is still the snappy ~1.4s default for fast iteration; the worker
is the quality option.) Footnote on placement: this also clarified the
"server on the gaming PC?" question — MLX is Apple-only, so the RTX 2080's real
job is the LLM (via the Phase-2 Wake-on-LAN routing), while STT/TTS/orchestrator
stay on the always-on host.

### STT: dropping Whisper for Parakeet (and the same Metal-thread trap)

Whisper `large-v3-turbo` was accurate but slow on the M1 — ~3.6s per turn, which
is the whole latency budget. Swapped in **NVIDIA Parakeet TDT 0.6b v3** (the
multilingual release — 25 European languages incl. German) on MLX: **~150ms warm,
~25x faster**, with equal-or-better German transcripts (it nailed the test clip
word-for-word). It was already half-wired as a Phase-1 candidate; only the model
ID needed bumping v2(English)→v3(multilingual).

But switching engines re-tripped the Metal-thread trap from the TTS saga: the
first time I actually *spoke* to the robot, MLX threw `no stream gpu in current
thread`. Same root cause — the control server spawns a fresh thread per turn, so
the model loaded on the prewarm thread but transcribed on a turn thread, and
MLX keeps a per-thread GPU stream. This time it's a recoverable exception, not a
segfault, so the fix is lighter than the TTS subprocess: `PinnedSTT`
(`src/stt/pinned.py`) runs the backend's *load and every transcribe* on one
dedicated single-thread executor. The server also warms the JIT with a 1s silent
clip at startup so the first real turn is ~150ms, not ~420ms. Lesson, twice over:
**any MLX/Metal model must be touched from a single consistent thread** — pin it
(STT, recoverable) or isolate it in a process (TTS, segfault-prone).

### The ESP32 firmware

`firmware/esp32_face_led/` — an Arduino sketch (arduinoWebSockets + ArduinoJson +
Adafruit NeoPixel) that joins the same `ws://host:8010/ws`, parses `phase`
events, and eases the onboard WS2812 between colours (listening = blue, thinking
= pulsing purple, speaking = green, error = red). It sends nothing; it's pure
output. The motor/motion `tool` events are a marked TODO for the next Phase-4
step.

## LLM upgrade — Gemma 4 and the thinking-mode trap

After the pipeline was stable I wanted a better model than `llama3.2` — snappier
German, better child-appropriate phrasing. Looked at the 2026 landscape:

- **Gemma 4** (Google, April 2026, Apache 2.0): two variants — a 26B MoE with only
  3.8 B active parameters (fast!) and a 31B dense (quality). German-language
  reviews specifically called it out: *"Gemma 4 formuliert auf Deutsch spuerbar
  natuerlicher und fluessiger"* (noticeably more natural and fluent German than
  Qwen 3.5). For a robot that talks to kids in German that matters.
- **Qwen 3.5** (Alibaba): hybrid thinking + direct mode, 201 languages, 262K
  context -- strong all-rounder but slightly below Gemma 4 on German.
- **Mistral Small 3 7B**: fastest raw tok/s on Apple Silicon (~50 tok/s), good if
  you need rock-bottom latency at some quality cost.

With 32 GB RAM the `gemma4:12b` variant fits easily (Q4_K_M, 8 GB, 100% GPU
offloaded via Metal). Pulled it, switched `LLM_MODEL=gemma4:12b` -- done.

### The trap: thinking mode is on by default

First real turn: STT 206ms, then **80 seconds of silence**, then finally a German
kid-joke. Total turn 101 s. The model was running 100% GPU, RAM pressure fine.
So what was taking 76 seconds before the first token?

Running a quick test revealed it immediately:

```
$ echo "Hi" | ollama run gemma4:12b
Thinking...
The user said "Hi". This is a standard greeting.
Acknowledge the greeting and offer assistance.

Hallo! ...
```

Gemma 4 ships with a hidden chain-of-thought (CoT) **thinking mode enabled by
default**. Before outputting a single word it silently generates hundreds of
reasoning tokens. For a voice assistant those tokens are pure latency -- the user
stares at a silent robot while the model debates how to say "Hallo".

The same capability flag exists on Qwen 3, DeepSeek-R1, and any Ollama model
that lists `thinking` under its capabilities.

### The fix: one line

The Ollama `/api/chat` endpoint accepts a top-level `think` boolean. Adding it to
the payload disables CoT globally for that request:

```python
# src/llm/ollama_llm.py
payload = {
    "model": self.model,
    "messages": messages,
    "stream": True,
    "think": False,          # disable CoT/thinking mode (Gemma4, Qwen3, etc.)
    "options": {"temperature": 0.7},
}
```

Result:

| | Before | After |
|---|---|---|
| LLM first token | **76,001 ms** | **~400 ms** |
| LLM total | **80,321 ms** | **~3,000 ms** |
| Full turn | **101,869 ms** | **~6,000 ms** |

**27x speedup from one boolean.** Quality is identical for child-appropriate
conversation -- the thinking tokens add nothing for "tell me a joke". Reasoning
mode is useful for hard math/logic tasks, not for a chatty robot.

### Rule of thumb going forward

For any interactive / voice use case: **always check whether the model has a
`thinking` capability and explicitly set `think: false`**. Load the model in the
CLI with `ollama run <model>` and see if it prints `Thinking...` before
answering. If it does, the API caller must opt out -- Ollama does not disable it
automatically just because you are streaming a voice loop.

## Phase A/B/C — making it an actual conversation (no button, barge-in)

Up to here the robot worked, but the interaction was a lie. You held a
push-to-talk button, let go, waited, and a complete sentence came back as a WAV
file the phone downloaded and played. That is a walkie-talkie, not a
conversation. Two things bugged the kids immediately: the **gaps between
sentences** ("why does it pause like that?") and the fact that you **can't
interrupt it** — once it starts a 4-sentence answer you're stuck listening to
all of it.

I sat down, traced exactly where the time goes, and then ported the three
mechanisms that make pibot feel alive. Wrote it up as
[ADR 0003](adr/0003-realtime-conversation-pipeline.md) first, then implemented
all of it.

### Where the gaps actually came from

I'd assumed the gaps were the LLM being slow. They weren't. The LLM streams
fine. The problem was the **consumer loop** in the orchestrator: it was fully
serial — synthesize sentence 1, play sentence 1, synthesize sentence 2, play
sentence 2. While sentence 1 is playing, nothing is synthesizing sentence 2. So
every sentence boundary costs you a full TTS synth time of silence. The more
natural the LLM's punctuation, the *worse* it sounded, because more sentences =
more gaps.

And within a sentence there was no streaming at all: `PiperTTS` and the macOS
`say` backend both call `subprocess.run(...)`, which only returns once the whole
WAV is written. Even the Qwen3-MLX backend — whose underlying `model.generate()`
is a *generator* that yields audio chunks as it produces them — was being
wrapped in `list(...)`, which throws the streaming away and waits for the last
chunk. I was paying for streaming-capable models and then buffering them by hand.

### The three phases

**Phase A — kill the button.** The phone now opens a single `AudioContext`,
captures the mic continuously, resamples to 16 kHz PCM16 in an
`onaudioprocess` callback, and streams raw frames to the server over a binary
WebSocket. The server runs the voice-activity detection now, not the human
finger: a per-client `StreamingSTT` (`src/stt/streaming.py`) gates frames
through a VAD (`src/stt/vad.py` — a zero-dependency energy VAD by default,
optional Silero ONNX), keeps a short preroll so it doesn't clip your first
syllable, emits `interim` transcripts every 250 ms for live captions, and fires
`final` after ~800 ms of silence. That `final` is what starts a turn. No button,
and it reuses the existing `STT.transcribe` so I didn't have to touch Parakeet.

**Phase B — stream the audio out, end to end.** I gave the orchestrator an
`AudioSink` (start / pcm / done callbacks) and `iter_sentence_pcm()`, and taught
the Qwen3-MLX backend a real `stream_pcm()` that stops wrapping the generator in
`list()` and yields PCM frames as the model makes them. The server forwards
those frames to the phone as binary WS messages (`tts_start{sample_rate}` →
binary PCM → `tts_done`), and the phone schedules them gaplessly with the Web
Audio API — `createBuffer`, convert Int16→Float32, and a `nextPlayTime`
accumulator with an 80 ms jitter buffer so chunks butt up against each other
seamlessly instead of each being a separate `<audio>` download. This one change
fixes *both* problems: first audio starts after the first chunk of the first
sentence, and there are no inter-sentence gaps because playback is a continuous
scheduled stream, not a sequence of files.

**Phase C — barge-in.** This is the bit that makes it feel human: you can talk
over it. The naive approach (just keep the mic open while the robot talks) fails
because the mic hears the robot's own voice from the speaker and treats it as
you interrupting. Browser echo cancellation wasn't clean enough for STT, so I
ported pibot's trick (`src/server/static/barge-in.js`): keep a ring buffer of
the audio we're *playing*, and for each mic frame correlate the mic signal
against that playback reference at delays of 20–420 ms to estimate how much of
the mic energy is just the robot bleeding back in. Barge-in only fires when the
mic is loud **and** the unexplained residual is high for several consecutive
frames — i.e. you're really talking, not just picking up the speaker. When it
fires, the client flushes the buffered mic preroll so the server transcribes
your interruption from its true start, and sends `barge_in`. The orchestrator
cancels cooperatively via a `threading.Event` the LLM and TTS loops check — no
thread is killed, the partial reply is kept in history so context stays coherent
— and stop-words ("stopp", "halt", "sei still") on the interim transcript abort
instantly without even waiting for the full sentence.

### Why a single shared AudioContext matters

One subtle bug I hit: the barge-in correlation only works if the mic frames and
the playback-reference frames are at the **same sample rate**. If mic capture and
TTS playback live in separate `AudioContext`s with different rates, the
correlation silently returns "all residual" and barge-in fires on the robot's
own voice. The fix is to use **one** `AudioContext` for both capture and
playback, and tap the *actual* output samples (via a pass-through
`ScriptProcessor`) to feed the reference ring — so what you correlate against is
literally what came out of the speaker.

### What it cost / what's left

The whole thing is behind a `CONVERSATION_MODE` flag; the old push-to-talk +
WAV-download path still works as a fallback. I validated the Python end with
lightweight fakes — VAD boundary detection, PCM framing, AudioSink streaming, and
"cancel mid-stream truncates the turn" all pass — and confirmed the server boots,
serves the new assets, and advertises `conversation_mode` in `/api/config`.

What I *can't* validate from the dev box is the stuff that needs the real
hardware loop: the phone mic into Silero, Qwen3-MLX `stream_pcm` on Metal, and —
most importantly — the barge-in thresholds. The `0.018` mic-RMS / `0.62`
residual / 5-frame defaults are pibot's numbers for his speaker and room; mine
will need tuning against the actual octobot speaker and the phone mic before it
feels right. That's the next on-hardware session.

## Face refresh: visor-style robot expression set

The original SVG face worked, but it looked more like floating eyes than a
robot head. I replaced it with a visor-style panel face in
`src/server/static/face.js` while keeping the same public API so the rest of the
web app (`app.js`) did not need changes.

What changed:

- New head shell + visor panel geometry (rounded frame, internal grid texture).
- Rectangular eye modules with glow layers and square pupils.
- Animated lids and brows still map to the same phases (`inactive`,
  `listening`, `thinking`, `speaking`, `error`).
- Mouth is now a filled path that morphs between smile/frown/open speech shapes
  instead of only resizing a flat bar.
- Status cheek LEDs pulse with phase glow to make idle/listening/speaking states
  clearer from a distance.

Behavior contracts that stayed stable:

- `setPhase(...)` still drives phase expressions.
- `setTalking(true|false)` still gates speech animation to real playback.
- `pulseMouth()` still adds chunk-level talking twitches.

Net result: same control logic, more intentional "robot face" styling.

## Fix: face dropped to "inactive" on the last sentence while still speaking

**Symptom:** at the very end of a reply, the avatar's face snapped to the
*inactive* expression even though the speaker was still playing the final
sentence.

**Root cause — a client/server race, not an animation bug.** In
`orchestrator.respond()` the phase is flipped back to `inactive` (push-to-talk)
or `listening` (conversation) as soon as the **last sentence is synthesized**,
and then `assistant_end` / `latency` / `phase` events are emitted. But in the
browser the final WAV segment is still sitting in the playback queue (`audioQ`),
playing. When the `phase=inactive` event arrived, `app.js` called
`face.setPhase("inactive")`, which both forces `_talking = false` and switches
the base expression — mid-sentence.

**Fix (client-side, `src/server/static/app.js`):** defer any *non-speaking*
face expression until local playback actually drains. `setPhase()` now parks the
incoming phase in `pendingFacePhase` while audio is busy
(`audioBusy()` = WAV queue still playing **or** `conv._isPlaying()` for streamed
PCM) and keeps the face in `speaking`. The pending expression is applied via
`applyPendingPhase()` when the WAV queue empties (`nextAudio`) or when the
conversation engine reports talking stopped (`onTalking(false)`). The header
status label still updates immediately; only the face is held in sync with what
you actually hear. A new `speaking` phase (next turn / next segment) applies
right away and clears any pending phase.

## Fix: speaking mouth was two lines instead of a solid area

The mouth `<path>` is a *closed* shape (`M … Q … Q … Z`) but was drawn with
`fill: "none"`, so only its stroked outline showed. When the mouth opened to
speak, the top-lip curve and bottom-lip curve separated and read as **two
parallel lines** rather than an open mouth.

Fix (`src/server/static/face.js`): give the mouth path a `fill` (same cyan as
the stroke) so the enclosed region renders as one solid area, add
`stroke-linejoin: round` for clean corners, and stop growing the stroke width
with mouth openness (it was `8 + open*4`, which exaggerated the outline). The
stroke is now a fixed thin edge that just rounds the filled shape — open speech
is a single solid blob, idle is a thin solid bar.

## Tweak: open mouth fill matches the lip lines

The open-mouth fill was a dark inner color (`rgba(4,10,28,0.92)`) to mimic a real
open mouth. Changed it to the same cyan as the lip lines (`#8be8ff`) so the
inside reads as a solid colored area rather than a dark cavity.

## Revert to circle eyes, keep the solid-color mouth

Went back to the round-eye avatar (circular sockets + glowing iris + sliding
eyelids) since it read better than the rectangular visor. Kept the mouth
improvement: the open mouth fills solid with `var(--face)` — the same color as
the lip lines — instead of the old translucent tint (`rgba(126,224,255,0.18)`).

## Mouth: shorter + always-solid inner fill

Two tweaks: narrowed the mouth (`mw` 150 → 104) so it isn't so wide, and made
the inner mouth fill solid (`var(--face)`) in every phase — previously only
filled when open past a threshold, so inactive/listening showed a hollow
outline. Now the mouth reads as a solid colored shape in all states.

---

# Hardware build log

## Background: Octobot PCB

The Octobot (Silverlit) runs on a single-layer PCB with three subsystems:

- **Brain IC** (center): handles IR remote, LED effects, and motor direction.
- **IR receiver** (right): receives commands from the toy remote.
- **H-bridge** (small black IC, bottom): drives the motor from the brain's direction signals.

There is only one brushed DC motor. The gearbox has two gear paths: reversing the motor direction
engages a different set of gears, so one direction walks and the other turns the head/platform.
This means the robot can only walk forward and turn in one direction (counter-clockwise).

## Decision: keep old PCB for sound / light / IR, replace motor path

### Why not parallel the old H-bridge with DRV8833

Two H-bridges driving the same motor simultaneously is a short-circuit hazard. If one drives
forward while the other drives reverse (or into brake mode), the outputs fight each other and can
destroy one or both drivers. Do not connect both H-bridge outputs to the motor at the same time.

### Chosen approach

1. Keep the original PCB powered — IR remote, music, and LEDs continue to work.
2. Disconnect the two motor wires from the original H-bridge outputs (cut traces or unsolder).
3. Connect the motor wires to DRV8833 AOUT1 / AOUT2 instead.
4. ESP32 drives AIN1 / AIN2 on the DRV8833.

The old "brain IC" can stay. It will try to drive its own H-bridge outputs, but those are now
floating (disconnected from the motor), so it causes no harm.

## Wiring

| Signal   | ESP32-S3 GPIO | DRV8833 pin |
|----------|--------------|-------------|
| AIN1     | GPIO 4       | AIN1        |
| AIN2     | GPIO 5       | AIN2        |
| Motor +  | —         | AOUT1       |
| Motor −  | —         | AOUT2       |
| VM       | Battery + | VM          |
| GND      | Battery − | GND (shared with ESP32 GND) |

Add a 100 µF electrolytic cap across VM / GND close to the DRV8833 for motor inrush protection
(same role as the caps on the original PCB).

### Motor direction

DRV8833 truth table (xIN1=H, xIN2=L → forward; xIN1=L, xIN2=H → reverse):

| Command     | AIN1 (GPIO 20) | AIN2 (GPIO 21) |
|-------------|---------------|---------------|
| forward     | HIGH          | LOW           |
| turn_left   | LOW           | HIGH          |
| stop/coast  | LOW           | LOW           |

If forward and turn are physically reversed after assembly, swap the AIN1 / AIN2 pin assignments
in `esp32/octobot.ino` (the `#define` lines at the top).

## Power

- **DRV8833 VM**: wire directly to the battery positive rail (4×AA ≈ 6 V). VM range is 2.7–10.8 V.
- **ESP32 3.3 V**: use the ESP32 devkit's onboard 3.3 V regulator (fed from USB during development;
  for standalone use, feed the devkit's 5 V pin from a 5 V LDO/buck tied to the battery).
- **Common GND**: battery negative, DRV8833 GND, and ESP32 GND must all connect.

No extra capacitors on the motor supply are required beyond the 100 µF bulk cap — the DRV8833 has
internal bootstrap circuitry. The original PCB's caps were there because the original brain IC had
no such protection.

## Software architecture

### Previous approach (FT232H)

```
Server (laptop) → WebSocket → Phone browser → WebUSB/FT232H → H-bridge → Motor
```

The phone acted as a USB-to-GPIO adapter. This required the phone to stay connected over USB.

### New approach (ESP32 WiFi)

```
Server (laptop) → HTTP POST /motor → ESP32 WiFi → DRV8833 → Motor
Phone: audio input/output, display, camera only
```

The ESP32 connects to the same WiFi network as the server. Set `ESP32_URL=http://<esp32-ip>` in the
server environment. The server calls the ESP32 directly; the phone no longer participates in motor
control.

### About USB from phone to ESP32

The FT232H used WebUSB (vendor-specific USB class, supported in Chrome/Edge).
The ESP32's built-in USB port enumerates as a CDC-Serial device, which requires the **Web Serial
API** (different from WebUSB). Chrome/Edge on Android support Web Serial, but:

- iOS Safari supports neither WebUSB nor Web Serial.
- The existing `motor.ts` client code speaks the FTDI protocol; it would need a full rewrite.
- WiFi removes the USB cable entirely and lets the server drive the motor without routing through
  the phone, which is simpler and more reliable.

WiFi is the recommended path. Web Serial is an option only if a USB tether from phone to ESP32 is
specifically required and iOS is not a target.

## ESP32 firmware

See `esp32/src/main.cpp` and `esp32/platformio.ini`. The firmware uses the Arduino framework
targeting ESP32 — no Arduino IDE needed.

### Tooling: PlatformIO in VS Code

1. Install the [PlatformIO IDE extension](https://marketplace.visualstudio.com/items?itemName=platformio.platformio-ide) in VS Code.
2. Open the `esp32/` folder (`File → Open Folder`).
3. PlatformIO detects `platformio.ini` and downloads the ESP32 toolchain and libraries automatically.
4. Click **Upload** (→ icon) or run `pio run --target upload` to flash.
5. Click **Monitor** (plug icon) or `pio device monitor` for Serial output.

Libraries are declared in `platformio.ini` under `lib_deps` — no manual installs:

- **ArduinoJson** 7.x (`bblanchon/ArduinoJson`)
- **WiFiManager** 2.0.x (`tzapu/WiFiManager`)

If your board is not a generic ESP32 DevKit, change the `board` value in `platformio.ini`.
See the comment at the top of that file for common alternatives (S3, C3, etc.).

### WiFi credentials — no hardcoding

Credentials are **not** in the sketch file and not in git. Instead WiFiManager is used:

1. First boot (or after a credential reset): ESP32 creates an open AP called **`PiBot-Setup`**.
2. Connect to it from any phone or laptop.
3. Open `http://192.168.4.1` — a captive portal lets you pick your SSID and enter the password.
4. Credentials are saved to ESP32 NVS flash and reused on every subsequent boot.
5. To reconfigure: hold the **BOOT button (GPIO 0)** for 3 seconds at startup.

After first-time setup, open Serial Monitor at 115200 baud to read the assigned IP, then set
`ESP32_URL=http://<ip>` in the server environment.

The `/motor` endpoint blocks for `durationMs` before responding, so the HTTP response signals
completion — this matches the existing RPC semantics where the server waits for the tool to finish
before the LLM receives the result.

## Server integration

Set `ESP32_URL=http://<esp32-ip>` in the environment. When this is set, the server's motor tool
sends commands directly to the ESP32 via HTTP instead of forwarding through the phone's WebSocket
connection. The phone WebSocket path remains as a fallback when `ESP32_URL` is not set.

`turn_left_degrees` (which normally uses the phone's orientation sensor for closed-loop angle
control) falls back to a timed `turn_left` when routing through the ESP32 — the server already
pre-calculates `durationMs` from the requested degrees, so the behaviour degrades gracefully.
