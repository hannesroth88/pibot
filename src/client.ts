type ServerMessage =
	| { type: "hello"; motorLog: Array<{ t: number; command: string; durationMs: number }> }
	| { type: "sim_motor"; command: string; durationMs: number }
	| { type: "take_photo_request"; id: string }
	| { type: "error"; message: string }
	| { type: "speak_request"; id: string; text: string }
	| {
			type: "stt_event";
			event: "loading" | "ready" | "speech_start" | "speech_end" | "speech_drop" | "error";
			message?: string;
	  }
	| { type: "stt_final"; text: string }
	| { type: "agent_event"; event: AgentEvent };

interface AgentMessageLike {
	role: string;
	content?: unknown;
}

type AgentEvent =
	| { type: "message_start"; message: AgentMessageLike }
	| { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
	| { type: "message_end"; message: AgentMessageLike }
	| { type: "tool_execution_start"; toolName: string; args: unknown }
	| { type: "other"; eventType: string };

type ConversationPhase = "idle" | "listening" | "thinking" | "speaking";
type RobotFaceState = "idle" | "listening" | "hearing" | "thinking" | "speaking" | "tool" | "error";

const setup = document.querySelector<HTMLElement>("#setup");
const robot = document.querySelector<HTMLElement>("#robot");
const logEl = document.querySelector<HTMLElement>("#log");
const face = document.querySelector<HTMLElement>("#face");
const promptInput = document.querySelector<HTMLInputElement>("#prompt");
const sendButton = document.querySelector<HTMLButtonElement>("#send");
const robotModeButton = document.querySelector<HTMLButtonElement>("#robotMode");
const backButton = document.querySelector<HTMLButtonElement>("#back");
const micButton = document.querySelector<HTMLButtonElement>("#mic");
const stopMicButton = document.querySelector<HTMLButtonElement>("#stopMic");
const ttsProviderSelect = document.querySelector<HTMLSelectElement>("#ttsProvider");
const testTtsButton = document.querySelector<HTMLButtonElement>("#testTts");
const enableCameraButton = document.querySelector<HTMLButtonElement>("#enableCamera");

if (
	!setup ||
	!robot ||
	!logEl ||
	!face ||
	!promptInput ||
	!sendButton ||
	!robotModeButton ||
	!backButton ||
	!micButton ||
	!stopMicButton ||
	!ttsProviderSelect ||
	!testTtsButton ||
	!enableCameraButton
) {
	throw new Error("Missing required DOM elements");
}

const logOutput = logEl;
const robotFace = face;
const ttsProviderControl = ttsProviderSelect;
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProtocol}://${location.host}`);
const ttsEnabledKey = "robot-tts-enabled";
const ttsProviderKey = "robot-tts-provider";
const targetSttSampleRate = 16000;

let recognitionWanted = false;
let micStream: MediaStream | undefined;
let micAudioContext: AudioContext | undefined;
let micSource: MediaStreamAudioSourceNode | undefined;
let micProcessor: ScriptProcessorNode | undefined;
let assistantSpeechBuffer = "";
let ttsEnabled = localStorage.getItem(ttsEnabledKey) === "true";
let phase: ConversationPhase = "idle";
let ignoreMicUntil = 0;
let currentTtsAudio: HTMLAudioElement | undefined;
let robotVoiceEffectCleanup: (() => void) | undefined;
let audioContext: AudioContext | undefined;
let ttsGeneration = 0;
let activeSpeakRequestId: string | undefined;
let cameraStream: MediaStream | undefined;
let cameraVideo: HTMLVideoElement | undefined;
const cameraEnabledKey = "robot-camera-enabled";
let cameraEnabled = localStorage.getItem(cameraEnabledKey) === "true";
ttsProviderControl.value = localStorage.getItem(ttsProviderKey) ?? "elevenlabs";

function stringifyLogValue(value: unknown): string {
	if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`.trim();
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function sendClientLog(level: "log" | "info" | "warn" | "error" | "debug" | "app", message: string): void {
	const payload = {
		type: "client_log",
		level,
		message: message.slice(0, 4000),
		url: location.href,
		userAgent: navigator.userAgent,
		time: Date.now(),
	};
	const body = JSON.stringify(payload);
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(body);
		return;
	}
	if (navigator.sendBeacon) {
		navigator.sendBeacon("/api/client-log", new Blob([body], { type: "application/json" }));
		return;
	}
	void fetch("/api/client-log", {
		method: "POST",
		body,
		headers: { "content-type": "application/json" },
		keepalive: true,
	});
}

function installClientLogForwarding(): void {
	for (const level of ["log", "info", "warn", "error", "debug"] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			original(...args);
			sendClientLog(level, args.map(stringifyLogValue).join(" "));
		};
	}
	window.addEventListener("error", (event) => {
		sendClientLog("error", `window error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
	});
	window.addEventListener("unhandledrejection", (event) => {
		sendClientLog("error", `unhandled rejection: ${stringifyLogValue(event.reason)}`);
	});
}

installClientLogForwarding();

function log(text: string, className = ""): void {
	const line = document.createElement("div");
	line.textContent = `${new Date().toLocaleTimeString()} ${text}`;
	if (className) line.className = className;
	logOutput.append(line);
	logOutput.scrollTop = logOutput.scrollHeight;
	console.info(`[app] ${text}`);
}

function send(data: unknown): void {
	if (ws.readyState !== WebSocket.OPEN) {
		sendClientLog("warn", `WebSocket not open; dropping message ${JSON.stringify(data).slice(0, 500)}`);
		return;
	}
	ws.send(JSON.stringify(data));
}

function setRobotFaceState(state: RobotFaceState): void {
	robotFace.className = `face ${state}`;
}

async function ensureCameraStream(): Promise<MediaStream> {
	if (cameraStream?.getVideoTracks().every((track) => track.readyState === "live")) return cameraStream;
	if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API unavailable");
	const stream = await navigator.mediaDevices.getUserMedia({
		video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
		audio: false,
	});
	cameraStream = stream;
	localStorage.setItem(cameraEnabledKey, "true");
	cameraEnabled = true;
	if (!cameraVideo) {
		cameraVideo = document.createElement("video");
		cameraVideo.muted = true;
		cameraVideo.playsInline = true;
		cameraVideo.autoplay = true;
		cameraVideo.style.position = "fixed";
		cameraVideo.style.width = "1px";
		cameraVideo.style.height = "1px";
		cameraVideo.style.opacity = "0";
		cameraVideo.style.pointerEvents = "none";
		document.body.append(cameraVideo);
	}
	cameraVideo.srcObject = stream;
	await cameraVideo.play().catch(() => undefined);
	return stream;
}

async function capturePhotoDataUrl(): Promise<string> {
	await ensureCameraStream();
	const video = cameraVideo;
	if (!video) throw new Error("Camera video element missing");
	if (video.readyState < 2) {
		await new Promise<void>((resolve) => {
			const handler = () => {
				video.removeEventListener("loadeddata", handler);
				resolve();
			};
			video.addEventListener("loadeddata", handler);
		});
	}
	const width = video.videoWidth || 640;
	const height = video.videoHeight || 480;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2d context unavailable");
	ctx.drawImage(video, 0, 0, width, height);
	return canvas.toDataURL("image/jpeg", 0.82);
}

async function handlePhotoRequest(id: string): Promise<void> {
	try {
		const dataUrl = await capturePhotoDataUrl();
		send({ type: "photo_result", id, dataUrl });
		log(`Captured photo for tool request ${id} (${dataUrl.length} chars)`, "agent");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		send({ type: "photo_result", id, error: message });
		log(`Photo capture failed: ${message}`, "agent");
	}
}

function setPhase(nextPhase: ConversationPhase): void {
	phase = nextPhase;
	if (nextPhase === "idle") setRobotFaceState("idle");
	if (nextPhase === "listening") setRobotFaceState("listening");
	if (nextPhase === "thinking") setRobotFaceState("thinking");
	if (nextPhase === "speaking") setRobotFaceState("speaking");
	log(`phase: ${phase}`);
}

function assistantMessageHasToolCall(message: AgentMessageLike): boolean {
	if (!Array.isArray(message.content)) return false;
	return message.content.some(
		(content) => typeof content === "object" && content !== null && "type" in content && content.type === "toolCall",
	);
}

function clearCurrentTtsAudio(): void {
	robotVoiceEffectCleanup?.();
	robotVoiceEffectCleanup = undefined;
	if (!currentTtsAudio) return;
	currentTtsAudio.onplay = null;
	currentTtsAudio.onended = null;
	currentTtsAudio.onerror = null;
	currentTtsAudio.pause();
	currentTtsAudio.removeAttribute("src");
	currentTtsAudio.load();
	currentTtsAudio = undefined;
}

function createRobotVoiceEffect(audio: HTMLAudioElement): void {
	try {
		audioContext ??= new AudioContext();
		void audioContext.resume();
		const source = audioContext.createMediaElementSource(audio);
		const highpass = audioContext.createBiquadFilter();
		highpass.type = "highpass";
		highpass.frequency.value = 150;
		const lowpass = audioContext.createBiquadFilter();
		lowpass.type = "lowpass";
		lowpass.frequency.value = 7200;
		const presence = audioContext.createBiquadFilter();
		presence.type = "peaking";
		presence.frequency.value = 2600;
		presence.Q.value = 0.9;
		presence.gain.value = 3.5;
		const compressor = audioContext.createDynamicsCompressor();
		compressor.threshold.value = -24;
		compressor.knee.value = 18;
		compressor.ratio.value = 3;
		compressor.attack.value = 0.006;
		compressor.release.value = 0.12;
		const dry = audioContext.createGain();
		dry.gain.value = 0.9;
		const ringModulator = audioContext.createGain();
		ringModulator.gain.value = 0;
		const ringWet = audioContext.createGain();
		ringWet.gain.value = 0.09;
		const ringOsc = audioContext.createOscillator();
		ringOsc.type = "sine";
		ringOsc.frequency.value = 42;
		ringOsc.connect(ringModulator.gain);
		ringOsc.start();
		const slap = audioContext.createDelay(0.25);
		slap.delayTime.value = 0.075;
		const slapWet = audioContext.createGain();
		slapWet.gain.value = 0.045;
		const output = audioContext.createGain();
		output.gain.value = 0.98;

		source.connect(highpass);
		highpass.connect(lowpass);
		lowpass.connect(presence);
		presence.connect(compressor);
		compressor.connect(dry);
		compressor.connect(ringModulator);
		ringModulator.connect(ringWet);
		dry.connect(output);
		ringWet.connect(output);
		dry.connect(slap);
		slap.connect(slapWet);
		slapWet.connect(output);
		output.connect(audioContext.destination);
		robotVoiceEffectCleanup = () => {
			ringOsc.stop();
			for (const node of [
				source,
				highpass,
				lowpass,
				presence,
				compressor,
				dry,
				ringModulator,
				ringWet,
				ringOsc,
				slap,
				slapWet,
				output,
			]) {
				node.disconnect();
			}
		};
		log("Robot voice effect enabled", "stt");
	} catch (error) {
		robotVoiceEffectCleanup = undefined;
		log(`Robot voice effect unavailable: ${error instanceof Error ? error.message : String(error)}`, "stt");
	}
}

function ttsOutputActive(): boolean {
	return phase === "speaking" || (currentTtsAudio !== undefined && !currentTtsAudio.paused && !currentTtsAudio.ended);
}

function micInputBlocked(): boolean {
	return Date.now() < ignoreMicUntil || ttsOutputActive();
}

function resampleToPcm16(input: Float32Array, inputSampleRate: number): Int16Array {
	const ratio = inputSampleRate / targetSttSampleRate;
	const outputLength = Math.max(1, Math.floor(input.length / ratio));
	const output = new Int16Array(outputLength);
	for (let i = 0; i < outputLength; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j] ?? 0;
		const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
		output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}
	return output;
}

function sendMicAudio(input: Float32Array, sampleRate: number): void {
	if (!recognitionWanted || ws.readyState !== WebSocket.OPEN || micInputBlocked()) return;
	const pcm = resampleToPcm16(input, sampleRate);
	ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
}

async function startRecognition(): Promise<void> {
	if (micStream || micAudioContext) return;
	recognitionWanted = true;
	try {
		micStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
			video: false,
		});
		micAudioContext = new AudioContext();
		micSource = micAudioContext.createMediaStreamSource(micStream);
		micProcessor = micAudioContext.createScriptProcessor(4096, 1, 1);
		micProcessor.onaudioprocess = (event) => {
			const input = event.inputBuffer.getChannelData(0);
			sendMicAudio(input, event.inputBuffer.sampleRate);
		};
		micSource.connect(micProcessor);
		micProcessor.connect(micAudioContext.destination);
		setPhase("listening");
		log(`local STT started: phone PCM -> Parakeet/Silero server, browserRate=${micAudioContext.sampleRate}`, "stt");
	} catch (error) {
		recognitionWanted = false;
		setPhase("idle");
		log(`local STT start failed: ${error instanceof Error ? error.message : String(error)}`, "stt");
	}
}

function stopRecognition(): void {
	recognitionWanted = false;
	micProcessor?.disconnect();
	micProcessor = undefined;
	micSource?.disconnect();
	micSource = undefined;
	for (const track of micStream?.getTracks() ?? []) track.stop();
	micStream = undefined;
	void micAudioContext?.close();
	micAudioContext = undefined;
	setPhase("idle");
	log("local STT stopped", "stt");
}

function resetRecognitionAfterTts(): void {
	ignoreMicUntil = Date.now() + 1500;
	if (recognitionWanted) setPhase("listening");
}

function interruptTtsOnly(): void {
	ttsGeneration++;
	clearCurrentTtsAudio();
	if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function interruptSpeech(): void {
	const requestId = activeSpeakRequestId;
	interruptTtsOnly();
	if (requestId) send({ type: "speak_cancelled", id: requestId });
	activeSpeakRequestId = undefined;
	ignoreMicUntil = Date.now() + 500;
	setRobotFaceState("error");
	send({ type: "abort" });
	setPhase(recognitionWanted ? "listening" : "idle");
	resetRecognitionAfterTts();
	log("TTS stopped, agent aborted", "stt");
}

function enableTts(): void {
	ttsEnabled = true;
	localStorage.setItem(ttsEnabledKey, "true");
}

function finishTts(message: string): void {
	clearCurrentTtsAudio();
	const requestId = activeSpeakRequestId;
	activeSpeakRequestId = undefined;
	if (requestId) send({ type: "speak_done", id: requestId });
	ignoreMicUntil = Date.now() + 500;
	setPhase(recognitionWanted ? "listening" : "idle");
	resetRecognitionAfterTts();
	log(message, "stt");
}

function selectedTtsProvider(): "elevenlabs" | "pocket" {
	return ttsProviderControl.value === "pocket" ? "pocket" : "elevenlabs";
}

function ttsProviderLabel(provider: "elevenlabs" | "pocket"): string {
	return provider === "pocket" ? "Pocket TTS" : "ElevenLabs pibot";
}

function speakGerman(text: string, requestId?: string): void {
	const trimmed = text.trim();
	if (!trimmed) {
		finishTts("TTS skipped: empty text");
		return;
	}

	const generation = ++ttsGeneration;
	const provider = selectedTtsProvider();
	const providerLabel = ttsProviderLabel(provider);
	activeSpeakRequestId = requestId;
	clearCurrentTtsAudio();
	setPhase("speaking");
	ignoreMicUntil = Number.POSITIVE_INFINITY;

	const audio = new Audio(`/api/tts?provider=${encodeURIComponent(provider)}&text=${encodeURIComponent(trimmed)}`);
	currentTtsAudio = audio;
	createRobotVoiceEffect(audio);
	audio.onplay = () => log(`${providerLabel} playing streamed response ${trimmed.length} chars`, "stt");
	audio.onended = () => {
		if (generation !== ttsGeneration) return;
		finishTts(`${providerLabel} finished, resetting STT`);
	};
	audio.onerror = () => {
		if (generation !== ttsGeneration) return;
		finishTts(`${providerLabel} failed, resetting STT`);
	};
	audio.play().catch((error: unknown) => {
		if (generation !== ttsGeneration) return;
		finishTts(
			`${providerLabel} play failed, resetting STT: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}

let reloadVersion: string | undefined;

async function pollReloadVersion(): Promise<void> {
	try {
		const response = await fetch("/__version", { cache: "no-store" });
		const data = (await response.json()) as { version?: string };
		if (!data.version) return;
		if (!reloadVersion) {
			reloadVersion = data.version;
			return;
		}
		if (data.version !== reloadVersion) location.reload();
	} catch (error) {
		sendClientLog("debug", `reload poll failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function connectReloadSocket(reloadOnOpen = false): void {
	const reloadWs = new WebSocket(`${wsProtocol}://${location.host}/__reload`);
	reloadWs.onopen = () => {
		if (reloadOnOpen) location.reload();
	};
	reloadWs.onmessage = () => location.reload();
	reloadWs.onclose = () => {
		setTimeout(() => connectReloadSocket(true), 500);
	};
	reloadWs.onerror = () => reloadWs.close();
}

connectReloadSocket();
void pollReloadVersion();
setInterval(() => void pollReloadVersion(), 2000);

ws.onopen = () => log("ws connected");
ws.onclose = (event) => log(`ws closed code=${event.code} reason=${event.reason || "none"}`);
ws.onerror = () => log("ws error", "agent");
ws.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as ServerMessage;
	if (message.type === "sim_motor") {
		log(`SIM MOTOR ${message.command} ${message.durationMs}ms`, "sim");
		setRobotFaceState(message.command === "stop" ? "listening" : "tool");
	}
	if (message.type === "take_photo_request") {
		log(`photo requested ${message.id}`, "agent");
		void handlePhotoRequest(message.id);
	}
	if (message.type === "error") {
		setPhase(recognitionWanted ? "listening" : "idle");
		log(`ERROR ${message.message}`);
	}
	if (message.type === "speak_request") {
		if (ttsEnabled) speakGerman(message.text, message.id);
		else send({ type: "speak_done", id: message.id });
	}
	if (message.type === "stt_event") {
		if (message.event === "loading") log("local STT loading Parakeet/Silero worker", "stt");
		if (message.event === "ready") log("local STT worker ready", "stt");
		if (message.event === "speech_start") {
			setRobotFaceState("hearing");
			log("STT speech started", "stt");
		}
		if (message.event === "speech_end") {
			setPhase("thinking");
			log("STT speech ended, transcribing", "stt");
		}
		if (message.event === "speech_drop") setPhase(recognitionWanted ? "listening" : "idle");
		if (message.event === "error") {
			setPhase("idle");
			setRobotFaceState("error");
			log(`STT error ${message.message ?? "unknown"}`, "stt");
		}
	}
	if (message.type === "stt_final") {
		log(`STT final: ${message.text || "-"}`, "stt");
		if (!message.text.trim()) setPhase(recognitionWanted ? "listening" : "idle");
	}
	if (message.type === "agent_event") {
		const agentEvent = message.event;
		if (agentEvent.type === "message_start" && agentEvent.message.role === "assistant") {
			setPhase("thinking");
			assistantSpeechBuffer = "";
		}
		if (agentEvent.type === "message_update" && agentEvent.assistantMessageEvent?.type === "text_delta") {
			const delta = agentEvent.assistantMessageEvent.delta ?? "";
			assistantSpeechBuffer += delta;
		}
		if (agentEvent.type === "message_end" && agentEvent.message.role === "assistant") {
			log(`LLM: ${assistantSpeechBuffer.trim()}`, "agent");
			if (assistantMessageHasToolCall(agentEvent.message)) log("LLM message contains tool call", "agent");
			if (!ttsEnabled) setPhase(recognitionWanted ? "listening" : "idle");
		}
		if (agentEvent.type === "tool_execution_start") {
			log(`tool ${agentEvent.toolName} ${JSON.stringify(agentEvent.args)}`, "agent");
		}
	}
};

sendButton.onclick = () => {
	const text = promptInput.value;
	setPhase("thinking");
	send({ type: "prompt", text });
	log(`typed: ${text}`);
};

robotModeButton.onclick = async () => {
	setup.hidden = true;
	robot.hidden = false;
	try {
		if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
	} catch (error) {
		log(`Fullscreen request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};

backButton.onclick = async () => {
	robot.hidden = true;
	setup.hidden = false;
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
	} catch (error) {
		log(`Fullscreen exit failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};

document.addEventListener("fullscreenchange", () => {
	if (!document.fullscreenElement && !robot.hidden) {
		robot.hidden = true;
		setup.hidden = false;
	}
});

robotFace.onclick = () => {
	if (ttsOutputActive()) interruptSpeech();
};

micButton.onclick = () => {
	log("STT start requested: local Parakeet/Silero", "stt");
	void startRecognition();
};

stopMicButton.onclick = stopRecognition;

enableCameraButton.onclick = async () => {
	try {
		await ensureCameraStream();
		log("Camera enabled", "agent");
	} catch (error) {
		log(`Camera enable failed: ${error instanceof Error ? error.message : String(error)}`, "agent");
	}
};

if (cameraEnabled) void ensureCameraStream().catch(() => undefined);

ttsProviderControl.onchange = () => {
	localStorage.setItem(ttsProviderKey, selectedTtsProvider());
	log(`TTS provider selected: ${ttsProviderLabel(selectedTtsProvider())}`, "stt");
};

testTtsButton.onclick = () => {
	enableTts();
	speakGerman("Hallo, ich bin dein kleiner Roboter. Die Sprachausgabe ist bereit.");
	log(`TTS enabled: ${ttsProviderLabel(selectedTtsProvider())}`, "stt");
};

log(
	"STT uses local Parakeet batch transcription with Silero VAD endpointing. TTS is switchable: ElevenLabs pibot or Kyutai Pocket.",
);
