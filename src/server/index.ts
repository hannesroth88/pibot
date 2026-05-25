import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { RobotState, ServerMessage } from "../types.js";
import { serverConfig } from "./config.js";
import { createRobotHarness, type RobotHarnessEvent } from "./harness.js";
import { createHttpServer } from "./http-server.js";
import { createLogger, formatEntry } from "./logger.js";
import { createFileMemoryStore } from "./memory-store.js";
import { RobotClient } from "./robot-client.js";
import { onShutdown } from "./shutdown.js";
import { createSttService, type SttEvent } from "./stt.js";
import { stopMotorFireAndForget } from "./tools/index.js";
import { createTtsService, type TtsEvent } from "./tts.js";
import { attachWebSockets as createWebSocketServer, type WebsocketEvent } from "./websocket-server.js";

let broadcast: (message: ServerMessage) => void = () => undefined;
let robotState: RobotState = { phase: "inactive" };
let speechActive = false;
let lastSpeechEndedAt = 0;

const logger = createLogger((entry) => {
	console.log(formatEntry(entry, true));
	broadcast({ type: "log", entry });
});
const serverLogger = logger.tag("server");
const agentLogger = logger.tag("agent");
const sttLogger = logger.tag("stt");
const ttsLogger = logger.tag("tts");
const contextLogger = logger.tag("context");
const executionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
const memoryStore = createFileMemoryStore(executionEnv, { path: serverConfig.memoryFile });
const robot = new RobotClient();
const tts = createTtsService({ onEvent: handleTtsEvent });
const stt = createSttService({ workerPath: serverConfig.parakeetSttWorkerPath, onEvent: handleSttEvent });
const harness = await createRobotHarness({
	env: executionEnv,
	memoryStore,
	maxContextImages: serverConfig.maxContextImages,
	robot,
	onEvent: handleHarnessEvent,
});
const http = createHttpServer({
	publicDir: serverConfig.publicDir,
	version: serverConfig.version,
	fetchTtsAudio: tts.fetchTtsAudio,
});
const websockets = createWebSocketServer({
	server: http.server,
	onEvent: handleWebsocketEvent,
});
broadcast = websockets.broadcast;

function setRobotState(state: RobotState): void {
	robotState = state;
	broadcast({ type: "state", state });
}

function assistantText(): string {
	return "assistantText" in robotState ? robotState.assistantText : "";
}

function submitPrompt(text: string): void {
	setRobotState({ phase: "thinking", heardText: text, assistantText: "" });
	void harness
		.current()
		.prompt(text)
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("busy")) {
				sttLogger.log(`ignored final while agent busy: ${JSON.stringify(text)}`);
				setRobotState({ phase: "listening" });
				return;
			}
			sttLogger.log(`prompt failed: ${message}`);
			setRobotState({ phase: "error", message });
		});
}

function handleSttEvent(event: SttEvent): void {
	if (event.type === "loading") sttLogger.log("loading Parakeet/Silero worker");
	if (event.type === "ready") {
		sttLogger.log(
			`Parakeet ready sampleRate=${event.sampleRate} vadChunkMs=${event.vadChunkMs} threshold=${event.vadThreshold} minSilenceMs=${event.minSilenceMs} prerollMs=${event.prerollMs} interimIntervalMs=${event.interimIntervalMs ?? "off"}`,
		);
		setRobotState({ phase: "listening" });
	}
	if (event.type === "worker_log") sttLogger.log(event.line);
	if (event.type === "worker_exit") {
		sttLogger.log(`Parakeet worker exited code=${event.code ?? "none"} signal=${event.signal ?? "none"}`);
	}
	if (event.type === "parse_error") sttLogger.log(`failed to parse worker line: ${event.line}; ${event.message}`);
	if (event.type === "speech_start") {
		sttLogger.log(`speech_start #${event.index}`);
		setRobotState({ phase: "hearing" });
	}
	if (event.type === "speech_end") {
		sttLogger.log(`speech_end #${event.index} duration=${event.duration.toFixed(2)}s`);
	}
	if (event.type === "speech_drop") {
		sttLogger.log(`speech_drop #${event.index} reason=${event.reason} duration=${event.duration.toFixed(2)}s`);
		setRobotState({ phase: "listening" });
	}
	if (event.type === "interim") {
		sttLogger.log(
			`interim #${event.index} audioMs=${event.audioMs} decodeMs=${event.decodeMs} text=${JSON.stringify(event.text)}`,
		);
	}
	if (event.type === "error") setRobotState({ phase: "error", message: event.message });
	if (event.type === "stop_detected") {
		sttLogger.log(`stop-word detected in ${event.source}`);
		void abortRobotTurn(`${event.source} stop word: ${event.text}`);
	}
	if (event.type === "final") {
		sttLogger.log(`final #${event.index} decodeMs=${event.decodeMs} text=${JSON.stringify(event.text)}`);
		if (!event.text || speechActive || Date.now() - lastSpeechEndedAt < 1500) {
			setRobotState({ phase: "listening" });
			return;
		}
		submitPrompt(event.text);
	}
}

function handleTtsEvent(event: TtsEvent): void {
	if (event.type === "speech_registered") {
		speechActive = true;
		ttsLogger.log(`registered speech id=${event.id} chars=${event.chars}`);
	}
	if (event.type === "speech_resolved") {
		speechActive = false;
		lastSpeechEndedAt = Date.now();
		ttsLogger.log(`speech resolved id=${event.id}`);
	}
	if (event.type === "pocket_starting") ttsLogger.log(`starting Pocket TTS: ${event.command}`);
	if (event.type === "pocket_ready") ttsLogger.log(`Pocket TTS ready at ${event.url}`);
	if (event.type === "pocket_log") ttsLogger.tag("pocket").log(event.line);
	if (event.type === "pocket_error") ttsLogger.log(`Pocket TTS failed to start: ${event.message}`);
	if (event.type === "pocket_exit") {
		ttsLogger.log(`Pocket TTS exited code=${event.code ?? "none"} signal=${event.signal ?? "none"}`);
	}
	if (event.type === "elevenlabs_voice_lookup_failed")
		ttsLogger.log(`ElevenLabs voice lookup failed: ${event.message}`);
}

async function speakAssistantText(text: string): Promise<void> {
	setRobotState(text ? { phase: "speaking", assistantText: text } : { phase: "listening" });
	const speech = tts.registerSpeech(text);
	if (!speech) return;
	try {
		await robot.execute({ type: "speak", payload: { url: speech.url, text }, timeoutMs: null });
	} finally {
		tts.resolveSpeech(speech.id);
		setRobotState({ phase: "listening" });
	}
}

async function handleHarnessEvent(event: RobotHarnessEvent): Promise<void> {
	if (event.type === "assistant_start") setRobotState({ phase: "thinking", assistantText: "" });
	if (event.type === "tool_start") {
		setRobotState({ phase: "tool", name: event.name, args: event.args, assistantText: assistantText() });
		agentLogger.log(`tool ${event.name} ${JSON.stringify(event.args)}`);
	}
	if (event.type === "assistant_end") {
		if (event.text) agentLogger.log(`LLM: ${event.text}`);
		await speakAssistantText(event.text);
	}
	if (event.type === "context_pruned") {
		contextLogger.log(`removed ${event.removedImages} old image(s), kept ${event.keptImages}`);
	}
	if (event.type === "session_reset") {
		setRobotState({ phase: "inactive" });
		agentLogger.log("session reset; context cleared");
	}
}

async function abortRobotTurn(reason: string): Promise<void> {
	agentLogger.log(`abort: ${reason}`);
	void robot.execute({ type: "cancel_speech", payload: { reason }, timeoutMs: 1000 }).catch(() => undefined);
	tts.resolveAllSpeech();
	robot.rejectAll(reason);
	stopMotorFireAndForget(robot);
	try {
		await harness.current().abort();
	} catch (error) {
		agentLogger.log(`harness abort error: ${error instanceof Error ? error.message : String(error)}`);
	}
	setRobotState({ phase: "listening" });
}

async function handleWebsocketEvent(event: WebsocketEvent): Promise<void> {
	if (event.type === "client_connected") {
		serverLogger.log("browser client connected");
		event.client.send(JSON.stringify({ type: "hello", state: robotState }));
		robot.setWebSocket(event.client);
		logger.tag("robot").log("active robot client connected");
	}
	if (event.type === "client_rejected") serverLogger.log("rejected extra ws client");
	if (event.type === "client_disconnected") {
		serverLogger.log("browser client disconnected");
		tts.resolveAllSpeech();
	}
	if (event.type === "client_message") {
		const msg = event.message;
		if (msg.type === "client_log") {
			logger.logRaw("client", msg.tags, msg.message, msg.time);
			return;
		}
		if (robot.handleMessage(msg)) return;
		if (msg.type === "abort") await abortRobotTurn("client abort");
		if (msg.type === "reset_session") {
			serverLogger.log("session reset: client request");
			await abortRobotTurn("reset: client request");
			await harness.reset("client request");
		}
	}
	if (event.type === "audio_frame") stt.handleAudioFrame(event.data);
	if (event.type === "message_error") logger.tag("server").tag("error").log(event.message);
}

onShutdown(async () => {
	tts.stopChildProcess();
	stt.stopChildProcess();
	robot.stop();
	await logger.flush();
});

http.server.listen(serverConfig.port, serverConfig.host, () =>
	serverLogger.log(`robot demo: http://${serverConfig.host}:${serverConfig.port}`),
);
