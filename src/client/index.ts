import type { MotorCommand, RobotRpcMap, RobotState, RobotWireRequest, ServerMessage } from "../types.js";

type ConversationPhase = "inactive" | "listening" | "thinking" | "speaking";
type RobotFaceState = "inactive" | "listening" | "hearing" | "thinking" | "speaking" | "tool" | "error";

const setup = document.querySelector<HTMLElement>("#setup");
const robot = document.querySelector<HTMLElement>("#robot");
const logEl = document.querySelector<HTMLElement>("#log");
const face = document.querySelector<HTMLElement>("#face");
const backButton = document.querySelector<HTMLButtonElement>("#back");
const ttsProviderSelect = document.querySelector<HTMLSelectElement>("#ttsProvider");
const startAllButton = document.querySelector<HTMLButtonElement>("#startAll");
const resetSessionButton = document.querySelector<HTMLButtonElement>("#resetSession");
const gyroStatusEl = document.querySelector<HTMLElement>("#gyroStatus");

if (
	!setup ||
	!robot ||
	!logEl ||
	!face ||
	!backButton ||
	!ttsProviderSelect ||
	!startAllButton ||
	!resetSessionButton ||
	!gyroStatusEl
) {
	throw new Error("Missing required DOM elements");
}

const logOutput = logEl;
const robotFace = face;
const setupSection = setup;
const robotSection = robot;
const ttsProviderControl = ttsProviderSelect;
const gyroStatus = gyroStatusEl;
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
let ttsEnabled = localStorage.getItem(ttsEnabledKey) === "true";
let phase: ConversationPhase = "inactive";
let serverRobotState: RobotState = { phase: "inactive" };
let currentFaceState: RobotFaceState = "inactive";
let ignoreMicUntil = 0;
let currentTtsAudio: HTMLAudioElement | undefined;
let robotVoiceEffectCleanup: (() => void) | undefined;
let audioContext: AudioContext | undefined;
let ttsGeneration = 0;
let activeSpeakRequestId: string | undefined;
let ttsSpeaking = false;
let errorUntil = 0;
let cameraStream: MediaStream | undefined;
let cameraVideo: HTMLVideoElement | undefined;
const cameraEnabledKey = "robot-camera-enabled";
let cameraEnabled = localStorage.getItem(cameraEnabledKey) === "true";
let robotStarted = false;
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

class ClientLogger {
	constructor(private readonly tags: string[] = []) {}

	tag(tag: string): ClientLogger {
		return new ClientLogger([...this.tags, tag]);
	}

	log(message: string): void {
		const payload = {
			type: "client_log",
			tags: this.tags,
			message: message.slice(0, 4000),
			time: Date.now(),
		};
		const body = JSON.stringify(payload);
		if (ws.readyState === WebSocket.OPEN) ws.send(body);
	}
}

const clientLogger = new ClientLogger();

window.addEventListener("error", (event) => {
	clientLogger.tag("error").log(`window error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
});
window.addEventListener("unhandledrejection", (event) => {
	clientLogger.tag("error").log(`unhandled rejection: ${stringifyLogValue(event.reason)}`);
});

const tagColors = ["#45d9ff", "#d783ff", "#ffd166", "#6ee7a8", "#7aa2ff", "#ff6b7a", "#9ca3af"];

function tagColor(tag: string): string {
	let hash = 0;
	for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
	return tagColors[Math.abs(hash) % tagColors.length]!;
}

function appendStructuredLogLine(origin: "server" | "client", tags: string[], message: string): void {
	const line = document.createElement("div");
	const displayTags = [origin, ...tags.filter((tag, index) => index !== 0 || tag !== origin)];
	line.append(`${new Date().toLocaleTimeString()} `);
	for (const tag of displayTags) {
		const span = document.createElement("span");
		span.textContent = `[${tag}]`;
		span.style.color = tagColor(tag);
		line.append(span);
	}
	line.append(` ${message}`);
	line.className = displayTags.join(" ");
	logOutput.append(line);
	logOutput.scrollTop = logOutput.scrollHeight;
}

function log(text: string, tag = ""): void {
	(tag ? clientLogger.tag(tag) : clientLogger).log(text);
}

function send(data: unknown): void {
	if (ws.readyState !== WebSocket.OPEN) {
		clientLogger.tag("warn").log(`WebSocket not open; dropping message ${JSON.stringify(data).slice(0, 500)}`);
		return;
	}
	ws.send(JSON.stringify(data));
}

function deriveRobotFaceState(): RobotFaceState {
	if (Date.now() < errorUntil) return "error";
	if (serverRobotState.phase === "speaking" || ttsSpeaking) return "speaking";
	return serverRobotState.phase;
}

function renderRobotFace(): void {
	const next = deriveRobotFaceState();
	if (next === currentFaceState) return;
	currentFaceState = next;
	robotFace.className = `face ${next}`;
}

function showErrorFor(durationMs: number): void {
	errorUntil = Date.now() + durationMs;
	renderRobotFace();
	setTimeout(renderRobotFace, durationMs + 20);
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

interface USBControlTransferParameters {
	requestType: "standard" | "class" | "vendor";
	recipient: "device" | "interface" | "endpoint" | "other";
	request: number;
	value: number;
	index: number;
}

interface USBOutTransferResult {
	status: "ok" | "stall" | "babble";
	bytesWritten: number;
}

interface USBEndpoint {
	endpointNumber: number;
	direction: "in" | "out";
	type: "bulk" | "interrupt" | "isochronous";
}

interface USBAlternateInterface {
	endpoints: USBEndpoint[];
}

interface USBInterface {
	interfaceNumber?: number;
	alternate: USBAlternateInterface;
}

interface USBConfiguration {
	interfaces: USBInterface[];
}

interface USBDevice {
	vendorId: number;
	productId: number;
	productName?: string;
	configuration: USBConfiguration | null;
	open(): Promise<void>;
	selectConfiguration(value: number): Promise<void>;
	claimInterface(value: number): Promise<void>;
	controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult>;
	transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
}

interface USB {
	getDevices(): Promise<USBDevice[]>;
	requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<USBDevice>;
}

declare global {
	interface Navigator {
		readonly usb?: USB;
	}
}

const FTDI_VENDOR = 0x0403;
const FT232H_PRODUCT = 0x6014;
const SIO_RESET = 0x00;
const SIO_SET_BITMODE = 0x0b;
const BITMODE_RESET = 0x00;
const BITMODE_BITBANG = 0x01;
const FT232H_INTERFACE_A = 1;
const FT232H_D4 = 0x10;
const FT232H_D5 = 0x20;
const FT232H_FORWARD_PIN = FT232H_D5;
const FT232H_TURN_LEFT_PIN = FT232H_D4;
const FT232H_DIRECTION_MASK = FT232H_D4 | FT232H_D5;

let ftDevice: USBDevice | undefined;
let ftOutEndpoint = 0x02;
let ftConnected = false;
let motorStopTimer: ReturnType<typeof setTimeout> | undefined;
let motorGeneration = 0;
let orientationTracking = false;
let currentHeading: number | undefined;
let currentHeadingAt = 0;
let currentOrientationAlpha: number | null = null;
let currentOrientationBeta: number | null = null;
let currentOrientationGamma: number | null = null;
let currentCompassHeading: number | undefined;
let orientationSampleCount = 0;

async function ftControl(request: number, value: number, index = FT232H_INTERFACE_A): Promise<void> {
	if (!ftDevice) throw new Error("FT232H not connected");
	const result = await ftDevice.controlTransferOut({
		requestType: "vendor",
		recipient: "device",
		request,
		value,
		index,
	});
	if (result.status !== "ok") throw new Error(`FT232H controlTransferOut failed: ${result.status}`);
}

async function ftSetBitbang(enabled: boolean): Promise<void> {
	const mode = enabled ? BITMODE_BITBANG : BITMODE_RESET;
	await ftControl(SIO_SET_BITMODE, FT232H_DIRECTION_MASK | (mode << 8));
}

async function ftWritePins(value: number): Promise<void> {
	if (!ftDevice) throw new Error("FT232H not connected");
	const result = await ftDevice.transferOut(ftOutEndpoint, new Uint8Array([value]));
	if (result.status !== "ok") throw new Error(`FT232H transferOut failed: ${result.status}`);
}

async function connectFt232h(promptIfMissing: boolean): Promise<boolean> {
	const usb = navigator.usb;
	if (!usb) {
		log("WebUSB unavailable; motors cannot run", "hardware");
		return false;
	}
	try {
		let device = (await usb.getDevices()).find(
			(entry) => entry.vendorId === FTDI_VENDOR && entry.productId === FT232H_PRODUCT,
		);
		if (!device && promptIfMissing) {
			device = await usb.requestDevice({
				filters: [{ vendorId: FTDI_VENDOR, productId: FT232H_PRODUCT }],
			});
		}
		if (!device) return false;
		ftDevice = device;
		await device.open();
		if (device.configuration === null) await device.selectConfiguration(1);
		const interfaces = device.configuration?.interfaces ?? [];
		log(
			`FT232H interfaces: ${interfaces
				.map(
					(iface, index) =>
						`#${index}/n=${iface.interfaceNumber ?? index}/eps=${iface.alternate.endpoints
							.map((endpoint) => `${endpoint.direction}:${endpoint.type}:${endpoint.endpointNumber}`)
							.join(",")}`,
				)
				.join(" | ")}`,
			"hardware",
		);

		const claimedInterfaceNumber = interfaces[0]?.interfaceNumber ?? 0;
		await device.claimInterface(claimedInterfaceNumber);
		const endpoint = interfaces[0]?.alternate.endpoints.find(
			(entry) => entry.direction === "out" && entry.type === "bulk",
		);
		if (!endpoint) throw new Error("FT232H bulk OUT endpoint not found after claiming interface");
		ftOutEndpoint = endpoint.endpointNumber;

		await ftControl(SIO_RESET, 0);
		await ftSetBitbang(true);
		await ftWritePins(0);
		ftConnected = true;
		log(
			`FT232H connected: ${device.productName ?? "FT232H"} interface=${claimedInterfaceNumber} ep=${ftOutEndpoint}`,
			"hardware",
		);
		return true;
	} catch (error) {
		ftDevice = undefined;
		ftConnected = false;
		log(`FT232H connect failed: ${error instanceof Error ? error.message : String(error)}`, "hardware");
		return false;
	}
}

function normalizeDegrees(value: number): number {
	return ((value % 360) + 360) % 360;
}

type TurnDirection = 1 | -1;

function turnProgressDegrees(start: number, current: number, direction: TurnDirection): number {
	return direction === 1 ? normalizeDegrees(current - start) : normalizeDegrees(start - current);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDegrees(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}°` : "-";
}

function updateGyroStatus(): void {
	gyroStatus.textContent = `Gyro: heading=${formatDegrees(currentHeading)} alpha=${formatDegrees(currentOrientationAlpha)} beta=${formatDegrees(currentOrientationBeta)} gamma=${formatDegrees(currentOrientationGamma)} compass=${formatDegrees(currentCompassHeading)}`;
}

function handleOrientation(event: DeviceOrientationEvent): void {
	const withCompass = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
	currentOrientationAlpha = event.alpha;
	currentOrientationBeta = event.beta;
	currentOrientationGamma = event.gamma;
	currentCompassHeading =
		typeof withCompass.webkitCompassHeading === "number" && Number.isFinite(withCompass.webkitCompassHeading)
			? normalizeDegrees(withCompass.webkitCompassHeading)
			: undefined;
	const heading = currentCompassHeading ?? event.alpha;
	if (typeof heading === "number" && Number.isFinite(heading)) {
		currentHeading = normalizeDegrees(heading);
		currentHeadingAt = Date.now();
		orientationSampleCount++;
	}
	updateGyroStatus();
}

async function startOrientationTracking(): Promise<boolean> {
	if (orientationTracking) return true;
	if (!("DeviceOrientationEvent" in window)) {
		log("Device orientation unavailable; degree turns disabled", "orientation");
		return false;
	}
	const orientationCtor = DeviceOrientationEvent as unknown as {
		requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
	};
	if (orientationCtor.requestPermission) {
		const permission = await orientationCtor.requestPermission();
		if (permission !== "granted") {
			log(`Device orientation permission not granted: ${permission}`, "orientation");
			return false;
		}
	}
	window.addEventListener("deviceorientation", handleOrientation);
	orientationTracking = true;
	updateGyroStatus();
	await waitForHeading(1200);
	log(
		`Orientation tracking ${currentHeading === undefined ? "started without heading yet" : `heading=${currentHeading.toFixed(1)}°`}`,
		"orientation",
	);
	return true;
}

async function waitForHeading(
	timeoutMs: number,
	options: { allowStale?: boolean; afterSample?: number } = {},
): Promise<number | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const hasRequestedSample = options.afterSample === undefined || orientationSampleCount > options.afterSample;
		if (currentHeading !== undefined && hasRequestedSample) {
			if (options.allowStale || Date.now() - currentHeadingAt < 1500) return currentHeading;
		}
		await delay(50);
	}
	return options.allowStale ? currentHeading : undefined;
}

function motorCommandPins(command: MotorCommand): number {
	if (command === "forward") return FT232H_FORWARD_PIN;
	if (command === "turn_left" || command === "turn_left_degrees") return FT232H_TURN_LEFT_PIN;
	return 0;
}

async function stopMotorPins(): Promise<void> {
	await ftWritePins(0);
}

async function pulseTurnLeft(pulseMs: number): Promise<void> {
	await ftWritePins(FT232H_TURN_LEFT_PIN);
	await delay(pulseMs);
	await stopMotorPins();
}

function chooseTurnDirection(
	startHeading: number,
	current: number,
	previousDirection: TurnDirection | undefined,
): TurnDirection {
	if (previousDirection) return previousDirection;
	const positive = turnProgressDegrees(startHeading, current, 1);
	const negative = turnProgressDegrees(startHeading, current, -1);
	if (positive < 180 && negative >= 180) return 1;
	if (negative < 180 && positive >= 180) return -1;
	if (positive < 180 && negative < 180) return positive >= negative ? 1 : -1;
	return 1;
}

async function pulseTurnFallback(untilMs: number, generation: number, reason: string): Promise<void> {
	const startedAt = Date.now();
	log(`gyro fallback timed pulse turn: ${reason}`, "robot");
	while (generation === motorGeneration && Date.now() - startedAt < untilMs) {
		await pulseTurnLeft(Math.min(180, Math.max(40, untilMs - (Date.now() - startedAt))));
		await delay(120);
	}
}

async function turnLeftByDegrees(degrees: number, maxDurationMs: number, generation: number): Promise<void> {
	const startHeading = await waitForHeading(1500, { allowStale: true });
	const targetDegrees = Math.max(1, Math.min(359, degrees));
	const startedAt = Date.now();
	const pulseMs = 140;
	const settleMs = 180;
	let turned = 0;
	let direction: TurnDirection | undefined;
	let missedFreshSamples = 0;
	if (startHeading === undefined) {
		await pulseTurnFallback(maxDurationMs, generation, "no initial heading");
		return;
	}
	try {
		while (generation === motorGeneration && Date.now() - startedAt < maxDurationMs) {
			const sampleBeforePulse = orientationSampleCount;
			await pulseTurnLeft(pulseMs);
			await delay(settleMs);
			const heading = await waitForHeading(450, { allowStale: true, afterSample: sampleBeforePulse });
			if (heading === undefined) {
				missedFreshSamples++;
				if (missedFreshSamples >= 3) break;
				continue;
			}
			if (orientationSampleCount <= sampleBeforePulse) missedFreshSamples++;
			else missedFreshSamples = 0;
			direction = chooseTurnDirection(startHeading, heading, direction);
			turned = turnProgressDegrees(startHeading, heading, direction);
			log(
				`gyro pulse target=${targetDegrees.toFixed(1)}° turned≈${turned.toFixed(1)}° heading=${heading.toFixed(1)}° dir=${direction} fresh=${orientationSampleCount > sampleBeforePulse}`,
				"robot",
			);
			if (turned >= targetDegrees || missedFreshSamples >= 3) break;
		}
		if (turned < targetDegrees && generation === motorGeneration) {
			const remainingMs = Math.max(0, maxDurationMs - (Date.now() - startedAt));
			await pulseTurnFallback(
				remainingMs,
				generation,
				`gyro progress stopped at ${turned.toFixed(1)}°/${targetDegrees.toFixed(1)}°`,
			);
		}
	} finally {
		await stopMotorPins();
	}
	if (generation !== motorGeneration) throw new Error("Degree turn aborted");
	log(`gyro turn_left_degrees target=${targetDegrees.toFixed(1)}° actual≈${turned.toFixed(1)}°`, "robot");
}

type MotorRequestPayload = RobotRpcMap["motor"]["request"];

async function handleMotorRequest(id: string, payload: MotorRequestPayload): Promise<void> {
	const { command, durationMs, degrees } = payload;
	const generation = ++motorGeneration;
	if (motorStopTimer) {
		clearTimeout(motorStopTimer);
		motorStopTimer = undefined;
	}
	if (!ftConnected) {
		send({
			type: "robot_response",
			id,
			requestType: "motor",
			payload: { ok: false, error: "FT232H not connected" },
		});
		return;
	}
	try {
		if (command === "turn_left_degrees") {
			await turnLeftByDegrees(Number(degrees ?? 45), durationMs, generation);
			send({ type: "robot_response", id, requestType: "motor", payload: { ok: true } });
			return;
		}
		const pins = motorCommandPins(command);
		await ftWritePins(pins);
		log(`motor ${command} pins=0b${pins.toString(2).padStart(8, "0")} duration=${durationMs}ms`, "robot");
		if (durationMs > 0 && pins !== 0) {
			await new Promise<void>((resolve) => {
				motorStopTimer = setTimeout(async () => {
					motorStopTimer = undefined;
					try {
						await stopMotorPins();
					} catch (error) {
						log(`motor stop failed: ${error instanceof Error ? error.message : String(error)}`, "hardware");
					}
					resolve();
				}, durationMs);
			});
		}
		send({ type: "robot_response", id, requestType: "motor", payload: { ok: true } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`motor request failed: ${message}`, "hardware");
		send({ type: "robot_response", id, requestType: "motor", payload: { ok: false, error: message } });
		try {
			await stopMotorPins();
		} catch {
			// best-effort
		}
	}
}

window.addEventListener("beforeunload", () => {
	if (!ftDevice) return;
	try {
		ftDevice.transferOut(ftOutEndpoint, new Uint8Array([0]));
	} catch {
		// best-effort
	}
});

async function handlePhotoRequest(id: string): Promise<void> {
	try {
		const dataUrl = await capturePhotoDataUrl();
		send({ type: "robot_response", id, requestType: "take_photo", payload: { dataUrl } });
		log(`Captured photo for tool request ${id} (${dataUrl.length} chars)`, "camera");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		send({ type: "robot_response", id, requestType: "take_photo", error: message });
		log(`Photo capture failed: ${message}`, "camera");
	}
}

async function handleRobotRequest(message: RobotWireRequest): Promise<void> {
	if (message.request.type === "take_photo") {
		log(`photo requested ${message.id}`, "camera");
		await handlePhotoRequest(message.id);
		return;
	}
	if (message.request.type === "motor") {
		await handleMotorRequest(message.id, message.request.payload);
		return;
	}
	if (message.request.type === "speak") {
		if (ttsEnabled) speakGerman(message.request.payload.url, message.request.payload.text, message.id);
		else send({ type: "robot_response", id: message.id, requestType: "speak", payload: { ok: true } });
		return;
	}
	if (message.request.type === "cancel_speech") {
		cancelSpeech(message.request.payload.reason);
		send({ type: "robot_response", id: message.id, requestType: "cancel_speech", payload: { ok: true } });
	}
}

function setPhase(nextPhase: ConversationPhase): void {
	if (phase !== nextPhase) {
		phase = nextPhase;
		log(`phase: ${phase}`);
	}
	renderRobotFace();
}

function setTtsSpeaking(active: boolean): void {
	ttsSpeaking = active;
	renderRobotFace();
}

function resetToListeningOrIdle(): void {
	setPhase(recognitionWanted ? "listening" : "inactive");
}

function startFaceAmpLoop(analyser: AnalyserNode): () => void {
	const data = new Uint8Array(analyser.fftSize);
	let smoothed = 0;
	let frameHandle = 0;
	let stopped = false;
	const tick = () => {
		if (stopped) return;
		analyser.getByteTimeDomainData(data);
		let sum = 0;
		for (const sample of data) {
			const centered = (sample - 128) / 128;
			sum += centered * centered;
		}
		const rms = Math.sqrt(sum / data.length);
		const amp = Math.min(1, rms * 3.4);
		smoothed = smoothed * 0.55 + amp * 0.45;
		robotFace.style.setProperty("--amp", smoothed.toFixed(3));
		frameHandle = requestAnimationFrame(tick);
	};
	frameHandle = requestAnimationFrame(tick);
	return () => {
		stopped = true;
		cancelAnimationFrame(frameHandle);
		robotFace.style.setProperty("--amp", "0");
	};
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
		const analyser = audioContext.createAnalyser();
		analyser.fftSize = 512;
		analyser.smoothingTimeConstant = 0.55;

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
		output.connect(analyser);

		const stopAmpLoop = startFaceAmpLoop(analyser);

		robotVoiceEffectCleanup = () => {
			stopAmpLoop();
			try {
				ringOsc.stop();
			} catch {
				// already stopped
			}
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
				analyser,
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

function micInputBlocked(): boolean {
	return Date.now() < ignoreMicUntil;
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
		setPhase("inactive");
		log(`local STT start failed: ${error instanceof Error ? error.message : String(error)}`, "stt");
	}
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

function cancelSpeech(reason: string): void {
	const requestId = activeSpeakRequestId;
	interruptTtsOnly();
	setTtsSpeaking(false);
	activeSpeakRequestId = undefined;
	if (requestId) send({ type: "robot_response", id: requestId, requestType: "speak", payload: { ok: true } });
	ignoreMicUntil = Date.now() + 500;
	resetToListeningOrIdle();
	log(`TTS cancelled: ${reason}`, "stt");
}

function stopLocalMotorsNow(): void {
	motorGeneration++;
	if (motorStopTimer) {
		clearTimeout(motorStopTimer);
		motorStopTimer = undefined;
	}
	if (ftConnected) void stopMotorPins().catch(() => undefined);
}

function abortCurrentAgentTurn(): void {
	const requestId = activeSpeakRequestId;
	interruptTtsOnly();
	setTtsSpeaking(false);
	stopLocalMotorsNow();
	if (requestId) send({ type: "robot_response", id: requestId, requestType: "speak", payload: { ok: true } });
	activeSpeakRequestId = undefined;
	ignoreMicUntil = Date.now() + 500;
	showErrorFor(700);
	send({ type: "abort" });
	resetToListeningOrIdle();
	resetRecognitionAfterTts();
	log("agent turn aborted by touch", "stt");
}

function enableTts(): void {
	ttsEnabled = true;
	localStorage.setItem(ttsEnabledKey, "true");
}

function finishTts(message: string): void {
	clearCurrentTtsAudio();
	setTtsSpeaking(false);
	const requestId = activeSpeakRequestId;
	activeSpeakRequestId = undefined;
	if (requestId) send({ type: "robot_response", id: requestId, requestType: "speak", payload: { ok: true } });
	ignoreMicUntil = Date.now() + 500;
	resetToListeningOrIdle();
	resetRecognitionAfterTts();
	log(message, "stt");
}

function selectedTtsProvider(): "elevenlabs" | "pocket" {
	return ttsProviderControl.value === "pocket" ? "pocket" : "elevenlabs";
}

function ttsProviderLabel(provider: "elevenlabs" | "pocket"): string {
	return provider === "pocket" ? "Pocket TTS" : "ElevenLabs pibot";
}

function speakGerman(url: string, text: string, requestId: string): void {
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
	setTtsSpeaking(true);
	setPhase("speaking");
	ignoreMicUntil = 0;

	const audio = new Audio(`${url}&provider=${encodeURIComponent(provider)}`);
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
let autoReloadPending = false;

function robotModeActive(): boolean {
	return !robotSection.hidden;
}

function requestAutoReload(reason: string): void {
	if (robotModeActive()) {
		if (!autoReloadPending) log(`Auto-reload deferred while robot mode is active: ${reason}`, "reload");
		autoReloadPending = true;
		return;
	}
	location.reload();
}

function reloadIfPending(): void {
	if (!autoReloadPending || robotModeActive()) return;
	location.reload();
}

async function pollReloadVersion(): Promise<void> {
	try {
		const response = await fetch("/__version", { cache: "no-store" });
		const data = (await response.json()) as { version?: string };
		if (!data.version) return;
		if (!reloadVersion) {
			reloadVersion = data.version;
			return;
		}
		if (data.version !== reloadVersion) requestAutoReload("server version changed");
	} catch (error) {
		clientLogger.tag("debug").log(`reload poll failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function connectReloadSocket(reloadOnOpen = false): void {
	const reloadWs = new WebSocket(`${wsProtocol}://${location.host}/__reload`);
	reloadWs.onopen = () => {
		if (reloadOnOpen) requestAutoReload("reload socket reconnected");
	};
	reloadWs.onmessage = () => requestAutoReload("reload socket message");
	reloadWs.onclose = () => {
		setTimeout(() => connectReloadSocket(true), 500);
	};
	reloadWs.onerror = () => reloadWs.close();
}

connectReloadSocket();
void pollReloadVersion();
setInterval(() => void pollReloadVersion(), 2000);

ws.onopen = () => log("connected to robot server", "network");
ws.onclose = (event) => {
	if (event.code === 1008) {
		showErrorFor(5000);
		appendStructuredLogLine(
			"client",
			["error"],
			`connection rejected: ${event.reason || "another client is already connected"}`,
		);
		return;
	}
	log(`disconnected from robot server code=${event.code} reason=${event.reason || "none"}`, "network");
};
ws.onerror = () => log("robot server connection error", "network");
ws.onmessage = (event) => {
	const message = JSON.parse(String(event.data)) as ServerMessage;

	if (message.type === "robot_request") {
		void handleRobotRequest(message);
	}
	if (message.type === "hello" || message.type === "state") {
		serverRobotState = message.state;
		renderRobotFace();
	}
	if (message.type === "log") {
		appendStructuredLogLine(message.entry.origin, message.entry.tags, message.entry.message);
	}
};

async function enterRobotMode(): Promise<void> {
	setupSection.hidden = true;
	robotSection.hidden = false;
	try {
		if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
	} catch (error) {
		log(`Fullscreen request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

startAllButton.onclick = async () => {
	if (robotStarted) {
		void enterRobotMode();
		return;
	}
	startAllButton.disabled = true;
	startAllButton.textContent = "Starting...";
	try {
		enableTts();
		log(`TTS enabled: ${ttsProviderLabel(selectedTtsProvider())}`, "stt");
		const usbOk = await connectFt232h(true);
		if (!usbOk) log("FT232H not connected; motor tools will report errors", "hardware");
		await startOrientationTracking().catch((error) =>
			log(`Orientation tracking failed: ${error instanceof Error ? error.message : String(error)}`, "orientation"),
		);
		try {
			await ensureCameraStream();
			log("Camera enabled", "camera");
		} catch (error) {
			log(`Camera enable failed: ${error instanceof Error ? error.message : String(error)}`, "camera");
		}
		await startRecognition();
		robotStarted = true;
		startAllButton.textContent = "Show face";
		startAllButton.disabled = false;
		await enterRobotMode();
	} catch (error) {
		robotStarted = false;
		startAllButton.textContent = "Start robot";
		startAllButton.disabled = false;
		throw error;
	}
};

backButton.onclick = async () => {
	robot.hidden = true;
	setup.hidden = false;
	reloadIfPending();
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
		reloadIfPending();
	}
});

function handleRobotTouch(event: PointerEvent): void {
	if (event.target === backButton) return;
	event.preventDefault();
	abortCurrentAgentTurn();
}

robotSection.addEventListener("pointerdown", handleRobotTouch);

resetSessionButton.onclick = () => {
	if (!confirm("Reset session? All context messages will be lost.")) return;
	send({ type: "reset_session" });
	log("session reset requested", "ui");
};

if (cameraEnabled) void ensureCameraStream().catch(() => undefined);

ttsProviderControl.onchange = () => {
	localStorage.setItem(ttsProviderKey, selectedTtsProvider());
	log(`TTS provider selected: ${ttsProviderLabel(selectedTtsProvider())}`, "stt");
};
