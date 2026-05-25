import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { extname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AgentHarness, type AgentTool, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type Api,
	getModel,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	Type,
} from "@earendil-works/pi-ai";
import { WebSocket, WebSocketServer } from "ws";
import { formatMemoriesForSystemPrompt, memoryTool } from "./memory.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(__dirname, "../public");
const port = Number(process.env.PORT ?? 8010);
const pocketTtsPort = Number(process.env.POCKET_TTS_PORT ?? 8020);
const pocketTtsBindHost = process.env.POCKET_TTS_BIND_HOST ?? "127.0.0.1";
const pocketTtsLanguage = process.env.POCKET_TTS_LANGUAGE ?? "german";
const pocketTtsVoice = process.env.POCKET_TTS_VOICE ?? "eve";
const pocketTtsUrl = process.env.POCKET_TTS_URL ?? `http://127.0.0.1:${pocketTtsPort}/tts`;
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID ?? "r1pUec9VJPfpUaMUuRX2";
const elevenLabsVoiceName = process.env.ELEVENLABS_VOICE_NAME ?? "pibot";
const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID ?? "eleven_v3";
const defaultTtsProvider = process.env.TTS_PROVIDER ?? "elevenlabs";
const parakeetSttWorkerPath = resolve(__dirname, "../scripts/parakeet-stt-worker.py");
const serverVersion = String(Date.now());

const motorParameters = Type.Object({
	durationMs: Type.Optional(Type.Number({ description: "Duration in ms. Max 3000. Defaults to 500." })),
});
type ClientLogLevel = "log" | "info" | "warn" | "error" | "debug" | "app";
type TtsProvider = "elevenlabs" | "pocket";

interface ClientLogMsg {
	type: "client_log";
	level: ClientLogLevel;
	message: string;
	url: string;
	userAgent: string;
	time: number;
}

type ClientMsg =
	| { type: "prompt"; text: string }
	| { type: "photo_result"; id: string; dataUrl?: string; error?: string }
	| { type: "sim_motor_result"; command: string; durationMs: number }
	| { type: "speak_done"; id: string }
	| { type: "speak_cancelled"; id: string }
	| ClientLogMsg
	| { type: "abort" };

interface PhotoCapture {
	dataUrl: string;
	mimeType: string;
	base64: string;
}

type SttWorkerMsg =
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			speechPadMs: number;
			prerollMs: number;
	  }
	| { type: "speech_start"; index: number; time: number }
	| { type: "speech_end"; index: number; duration: number }
	| { type: "speech_drop"; index: number; duration: number; reason: string }
	| { type: "final"; index: number; text: string; duration: number; decodeMs: number }
	| { type: "error"; message: string };

const clients = new Set<WebSocket>();
const pendingSpeech = new Map<string, { client: WebSocket; resolve: () => void; timeout: NodeJS.Timeout }>();
const pendingPhotos = new Map<
	string,
	{
		client: WebSocket;
		resolve: (capture: PhotoCapture) => void;
		reject: (error: Error) => void;
		timeout: NodeJS.Timeout;
	}
>();
const clientUserAgents = new Map<WebSocket, string>();
let robotClient: WebSocket | undefined;
let pocketTtsProcess: ChildProcess | undefined;
let pocketTtsStartPromise: Promise<void> | undefined;
let pocketTtsLastError: Error | undefined;
let parakeetSttProcess: ChildProcess | undefined;
let parakeetSttReady = false;
let parakeetSttLoadingAnnounced = false;
let parakeetSttStdout = "";
let sttPromptQueue: Promise<void> = Promise.resolve();
const motorLog: Array<{ t: number; command: string; durationMs: number }> = [];

function stopChildProcesses(): void {
	pocketTtsProcess?.kill();
	parakeetSttProcess?.kill();
}

process.once("exit", stopChildProcesses);
process.once("SIGINT", () => {
	stopChildProcesses();
	process.exit(130);
});
process.once("SIGTERM", () => {
	stopChildProcesses();
	process.exit(143);
});

function readRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function readRequestJson(req: AsyncIterable<Uint8Array>): Promise<unknown> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of req) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function logClientMessage(msg: ClientLogMsg): void {
	const level = msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "log";
	console[level](`[client:${msg.level}] ${msg.message} (${msg.url}) ua=${msg.userAgent}`);
}

function broadcast(data: unknown): void {
	const msg = JSON.stringify(data);
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) client.send(msg);
	}
}

function startParakeetSttWorker(): void {
	if (parakeetSttProcess && !parakeetSttProcess.killed) return;
	parakeetSttReady = false;
	parakeetSttLoadingAnnounced = false;
	parakeetSttStdout = "";
	console.log("[stt] starting Parakeet STT worker via uvx");
	const child = spawn("uvx", ["--with", "parakeet-mlx", "--with", "silero-vad", "python", parakeetSttWorkerPath], {
		stdio: ["pipe", "pipe", "inherit"],
	});
	parakeetSttProcess = child;
	child.stdout?.on("data", (data: Buffer) => handleParakeetSttStdout(data));
	child.once("error", (error) => {
		broadcast({ type: "stt_event", event: "error", message: error.message });
		console.error(`[stt] Parakeet worker failed to start: ${error.message}`);
	});
	child.once("exit", (code, signal) => {
		if (parakeetSttProcess === child) parakeetSttProcess = undefined;
		parakeetSttReady = false;
		console.warn(`[stt] Parakeet worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
	});
}

function handleParakeetSttStdout(data: Buffer): void {
	parakeetSttStdout += data.toString("utf8");
	while (true) {
		const newline = parakeetSttStdout.indexOf("\n");
		if (newline < 0) return;
		const line = parakeetSttStdout.slice(0, newline).trim();
		parakeetSttStdout = parakeetSttStdout.slice(newline + 1);
		if (!line) continue;
		try {
			handleParakeetSttMessage(JSON.parse(line) as SttWorkerMsg);
		} catch (error) {
			console.warn(
				`[stt] failed to parse worker line: ${line}; ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function enqueueSttPrompt(text: string): void {
	sttPromptQueue = sttPromptQueue.then(async () => {
		for (let attempt = 1; attempt <= 30; attempt++) {
			try {
				await harness.prompt(`Vom Benutzer gehört: ${text}`);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("busy") || attempt === 30) {
					console.warn(`[stt] prompt failed: ${message}`);
					broadcast({ type: "stt_event", event: "error", message });
					return;
				}
				console.log(`[stt] harness busy; retrying prompt in 500ms attempt=${attempt}`);
				await sleep(500);
			}
		}
	});
}

function handleParakeetSttMessage(message: SttWorkerMsg): void {
	if (message.type === "ready") {
		parakeetSttReady = true;
		console.log(
			`[stt] Parakeet ready sampleRate=${message.sampleRate} vadChunkMs=${message.vadChunkMs} threshold=${message.vadThreshold} minSilenceMs=${message.minSilenceMs} prerollMs=${message.prerollMs}`,
		);
		broadcast({ type: "stt_event", event: "ready" });
		return;
	}
	if (message.type === "speech_start") {
		console.log(`[stt] speech_start #${message.index}`);
		broadcast({ type: "stt_event", event: "speech_start" });
		return;
	}
	if (message.type === "speech_end") {
		console.log(`[stt] speech_end #${message.index} duration=${message.duration.toFixed(2)}s`);
		broadcast({ type: "stt_event", event: "speech_end" });
		return;
	}
	if (message.type === "speech_drop") {
		console.log(
			`[stt] speech_drop #${message.index} reason=${message.reason} duration=${message.duration.toFixed(2)}s`,
		);
		broadcast({ type: "stt_event", event: "speech_drop" });
		return;
	}
	if (message.type === "final") {
		const text = message.text.trim();
		console.log(`[stt] final #${message.index} decodeMs=${message.decodeMs} text=${JSON.stringify(text)}`);
		broadcast({ type: "stt_final", text });
		if (text) enqueueSttPrompt(text);
		return;
	}
	console.warn(`[stt] worker error: ${message.message}`);
	broadcast({ type: "stt_event", event: "error", message: message.message });
}

function handleAudioFrame(data: Buffer): void {
	startParakeetSttWorker();
	if (!parakeetSttProcess?.stdin || parakeetSttProcess.stdin.destroyed) return;
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(data.byteLength, 0);
	parakeetSttProcess.stdin.write(header);
	parakeetSttProcess.stdin.write(data);
	if (!parakeetSttReady && !parakeetSttLoadingAnnounced) {
		parakeetSttLoadingAnnounced = true;
		broadcast({ type: "stt_event", event: "loading" });
	}
}

function resolveSpeech(id: string): void {
	const pending = pendingSpeech.get(id);
	if (!pending) return;
	console.log(`[tts] speech resolved id=${id}`);
	clearTimeout(pending.timeout);
	pendingSpeech.delete(id);
	pending.resolve();
}

function resolveSpeechForClient(client: WebSocket): void {
	for (const [id, pending] of pendingSpeech) {
		if (pending.client === client) resolveSpeech(id);
	}
}

function resolveAllSpeech(): void {
	for (const id of pendingSpeech.keys()) resolveSpeech(id);
}

function rejectPhoto(id: string, error: Error): void {
	const pending = pendingPhotos.get(id);
	if (!pending) return;
	clearTimeout(pending.timeout);
	pendingPhotos.delete(id);
	pending.reject(error);
}

function resolvePhoto(id: string, capture: PhotoCapture): void {
	const pending = pendingPhotos.get(id);
	if (!pending) return;
	clearTimeout(pending.timeout);
	pendingPhotos.delete(id);
	pending.resolve(capture);
}

function rejectPhotosForClient(client: WebSocket): void {
	for (const [id, pending] of pendingPhotos) {
		if (pending.client === client) rejectPhoto(id, new Error("Robot client disconnected"));
	}
}

function rejectAllPhotos(reason: string): void {
	for (const id of pendingPhotos.keys()) rejectPhoto(id, new Error(reason));
}

async function capturePhotoFromClient(): Promise<PhotoCapture> {
	const client = robotClient;
	if (!client || client.readyState !== WebSocket.OPEN) throw new Error("Robot client not connected");
	const id = randomUUID();
	client.send(JSON.stringify({ type: "take_photo_request", id }));
	return await new Promise<PhotoCapture>((resolve, reject) => {
		const timeout = setTimeout(() => rejectPhoto(id, new Error("Photo capture timed out")), 15000);
		pendingPhotos.set(id, { client, resolve, reject, timeout });
	});
}

function extractAssistantText(message: unknown): string {
	const record = readRecord(message);
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((entry) => {
			const item = readRecord(entry);
			return item.type === "text" && typeof item.text === "string" ? item.text : "";
		})
		.join("")
		.trim();
}

function isMobileRobotClient(client: WebSocket): boolean {
	return /Android|Mobile/i.test(clientUserAgents.get(client) ?? "");
}

function selectRobotClient(candidate: WebSocket): void {
	if (!robotClient || robotClient.readyState !== WebSocket.OPEN || isMobileRobotClient(candidate)) {
		robotClient = candidate;
		console.log(`[robot] selected client ua=${clientUserAgents.get(candidate) ?? "unknown"}`);
	}
}

async function speakOnClient(text: string): Promise<void> {
	const client = robotClient;
	if (!client || client.readyState !== WebSocket.OPEN) {
		console.warn("[tts] no robot client connected for speech");
		return;
	}
	const trimmed = text.trim();
	if (!trimmed) return;
	const id = randomUUID();
	console.log(`[tts] speak_request id=${id} chars=${trimmed.length} ua=${clientUserAgents.get(client) ?? "unknown"}`);
	client.send(JSON.stringify({ type: "speak_request", id, text: trimmed }));
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => resolveSpeech(id), 30000);
		pendingSpeech.set(id, { client, resolve, timeout });
	});
}

function selectModel(): Model<Api> {
	const provider = process.env.PI_PROVIDER ?? "anthropic";
	const modelId = process.env.PI_MODEL ?? "claude-haiku-4-5";
	if (!getProviders().includes(provider as KnownProvider)) {
		throw new Error(`Unknown PI_PROVIDER: ${provider}`);
	}
	const models = getModels(provider as KnownProvider);
	if (!models.some((model) => model.id === modelId)) {
		throw new Error(`Unknown PI_MODEL for ${provider}: ${modelId}`);
	}
	return getModel(provider as KnownProvider, modelId as never) as Model<Api>;
}

function motorTool(name: string, description: string): AgentTool {
	return {
		name,
		label: name,
		description,
		executionMode: "sequential",
		parameters: motorParameters,
		execute: async (_id, params) => {
			const durationMs = Math.max(0, Math.min(3000, Number(readRecord(params).durationMs ?? 500)));
			motorLog.push({ t: Date.now(), command: name, durationMs });
			broadcast({ type: "sim_motor", command: name, durationMs });
			await new Promise((resolveTimeout) => setTimeout(resolveTimeout, Math.min(durationMs, 300)));
			return {
				content: [{ type: "text", text: `Simulated ${name} for ${durationMs}ms.` }],
				details: { command: name, durationMs },
			};
		},
	};
}

const tools = [
	motorTool("move_forward", "Drive forward for a short duration. Hardware supports forward motion only."),
	motorTool(
		"turn_left",
		"Rotate counter-clockwise (left) in place for a short duration. Hardware supports rotation in this direction only.",
	),
	{
		name: "stop",
		label: "Stop",
		description: "Emergency/safety stop. Simulated for now.",
		executionMode: "sequential",
		parameters: Type.Object({}),
		execute: async () => {
			motorLog.push({ t: Date.now(), command: "stop", durationMs: 0 });
			broadcast({ type: "sim_motor", command: "stop", durationMs: 0 });
			return { content: [{ type: "text", text: "Simulated stop." }], details: { command: "stop" } };
		},
	} satisfies AgentTool,
	{
		name: "take_photo",
		label: "Take Photo",
		description:
			"Take a photo using the phone front-facing camera and return it to you. Use this to look at what the user shows you.",
		parameters: Type.Object({}),
		execute: async () => {
			const capture = await capturePhotoFromClient();
			return {
				content: [
					{ type: "text", text: "Aktuelles Kamerabild vom Roboter." },
					{ type: "image", data: capture.base64, mimeType: capture.mimeType },
				],
				details: { mimeType: capture.mimeType, bytes: capture.base64.length },
			};
		},
	} satisfies AgentTool,
	memoryTool,
];

const session = await new InMemorySessionRepo().create({ id: "robot-demo" });
const harness = new AgentHarness({
	env: new NodeExecutionEnv({ cwd: process.cwd() }),
	session,
	model: selectModel(),
	getApiKeyAndHeaders: async (model) => {
		const envName = `${model.provider.toUpperCase()}_API_KEY`.replaceAll("-", "_");
		const apiKey = process.env[envName] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
		return apiKey ? { apiKey } : undefined;
	},
	tools,
	systemPrompt:
		async () => `Du bist das Gehirn eines kleinen Roboters mit Smartphone. Antworte immer auf Deutsch. Sei verspielt, freundlich und sicher. Verwende keine Emojis. Nutze Bewegungswerkzeuge nur für kurze Dauer. Stoppe nach Bewegungssequenzen immer. Die Hardware kann nur vorwärts fahren und sich gegen den Uhrzeigersinn drehen; rückwärts und rechts gibt es nicht. Die Motorwerkzeuge sind aktuell nur simuliert, damit wir sicher debuggen können.

Persistente Erinnerungen:
${await formatMemoriesForSystemPrompt()}

Memory-Tool-Aufrufschema:
- Alle Erinnerungen lesen: memory({"action":"read"})
- Neue Erinnerung speichern: memory({"action":"append","text":"Pipi ist der Name des Roboters"})
- Erinnerung löschen: memory({"action":"remove","index":0})`,
});

harness.subscribe(async (event) => {
	broadcast({ type: "agent_event", event });
	if (event.type === "message_end" && event.message.role === "assistant") {
		await speakOnClient(extractAssistantText(event.message));
	}
});

function pocketTtsEndpoint(): { host: string; port: number } {
	const url = new URL(pocketTtsUrl);
	return { host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
}

async function canConnectToPocketTts(): Promise<boolean> {
	const endpoint = pocketTtsEndpoint();
	return await new Promise<boolean>((resolve) => {
		const socket = createConnection({ host: endpoint.host, port: endpoint.port });
		const done = (connected: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(connected);
		};
		socket.setTimeout(500);
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.once("timeout", () => done(false));
	});
}

function startPocketTtsProcess(): void {
	if (pocketTtsProcess && !pocketTtsProcess.killed) return;
	pocketTtsLastError = undefined;
	console.log(
		`[tts] starting Pocket TTS: uvx pocket-tts serve --language ${pocketTtsLanguage} --host ${pocketTtsBindHost} --port ${pocketTtsPort}`,
	);
	const child = spawn(
		"uvx",
		[
			"pocket-tts",
			"serve",
			"--language",
			pocketTtsLanguage,
			"--host",
			pocketTtsBindHost,
			"--port",
			String(pocketTtsPort),
		],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
	pocketTtsProcess = child;
	child.once("error", (error) => {
		pocketTtsLastError = error;
		console.error(`[tts] Pocket TTS failed to start: ${error.message}`);
	});
	child.once("exit", (code, signal) => {
		if (pocketTtsProcess === child) pocketTtsProcess = undefined;
		if (code !== 0) console.warn(`[tts] Pocket TTS exited code=${code ?? "none"} signal=${signal ?? "none"}`);
	});
}

async function ensurePocketTtsStarted(): Promise<void> {
	if (await canConnectToPocketTts()) return;
	pocketTtsStartPromise ??= (async () => {
		if (!(await canConnectToPocketTts())) startPocketTtsProcess();
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			if (pocketTtsLastError) throw pocketTtsLastError;
			if (await canConnectToPocketTts()) {
				console.log(`[tts] Pocket TTS ready at ${pocketTtsUrl}`);
				return;
			}
			await sleep(500);
		}
		throw new Error("Pocket TTS did not become ready within 60s. Install uv and ensure uvx pocket-tts works.");
	})();
	try {
		await pocketTtsStartPromise;
	} finally {
		pocketTtsStartPromise = undefined;
	}
}

function normalizeTtsProvider(value: string | undefined): TtsProvider {
	if (value === "pocket" || value === "kyutai") return "pocket";
	return "elevenlabs";
}

async function resolveElevenLabsVoiceId(): Promise<string> {
	if (!elevenLabsApiKey || process.env.ELEVENLABS_VOICE_ID) return elevenLabsVoiceId;
	try {
		const response = await fetch("https://api.elevenlabs.io/v1/voices", {
			headers: { "xi-api-key": elevenLabsApiKey },
		});
		if (!response.ok) return elevenLabsVoiceId;
		const data = (await response.json()) as { voices?: Array<{ name?: string; voice_id?: string }> };
		const voice = data.voices?.find((entry) => entry.name === elevenLabsVoiceName);
		return voice?.voice_id ?? elevenLabsVoiceId;
	} catch (error) {
		console.warn(`[tts] ElevenLabs voice lookup failed: ${error instanceof Error ? error.message : String(error)}`);
		return elevenLabsVoiceId;
	}
}

async function proxyAudioResponse(response: Response, res: ServerResponse, fallbackContentType: string): Promise<void> {
	if (!response.ok || !response.body) {
		res.writeHead(response.status || 502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: await response.text() }));
		return;
	}
	res.writeHead(200, {
		"content-type": response.headers.get("content-type") ?? fallbackContentType,
		"cache-control": "no-store",
	});
	for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
		res.write(chunk);
	}
	res.end();
}

async function handlePocketTtsRequest(text: string, res: ServerResponse): Promise<void> {
	await ensurePocketTtsStarted();
	const form = new FormData();
	form.set("text", text);
	form.set("voice_url", pocketTtsVoice);
	await proxyAudioResponse(await fetch(pocketTtsUrl, { method: "POST", body: form }), res, "audio/wav");
}

async function handleElevenLabsTtsRequest(text: string, res: ServerResponse): Promise<void> {
	if (!elevenLabsApiKey) {
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "ELEVENLABS_API_KEY missing" }));
		return;
	}
	const voiceId = await resolveElevenLabsVoiceId();
	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
		{
			method: "POST",
			headers: {
				accept: "audio/mpeg",
				"content-type": "application/json",
				"xi-api-key": elevenLabsApiKey,
			},
			body: JSON.stringify({ text, model_id: elevenLabsModelId }),
		},
	);
	await proxyAudioResponse(response, res, "audio/mpeg");
}

async function handleTtsRequest(text: string, providerValue: string | undefined, res: ServerResponse): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "text required" }));
		return;
	}
	const provider = normalizeTtsProvider(providerValue ?? defaultTtsProvider);
	res.setHeader("x-pibot-tts-provider", provider);
	if (provider === "pocket") await handlePocketTtsRequest(trimmed, res);
	else await handleElevenLabsTtsRequest(trimmed, res);
}

function parsePhotoDataUrl(dataUrl: string): { base64: string; mimeType: string } | undefined {
	const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
	if (!match) return undefined;
	return { mimeType: match[1] ?? "image/jpeg", base64: match[2] ?? "" };
}

async function handleClientMessage(msg: ClientMsg): Promise<void> {
	if (msg.type === "client_log") {
		logClientMessage(msg);
		return;
	}
	if (msg.type === "speak_done" || msg.type === "speak_cancelled") {
		resolveSpeech(msg.id);
		return;
	}
	if (msg.type === "photo_result") {
		if (msg.error) {
			rejectPhoto(msg.id, new Error(msg.error));
			return;
		}
		if (!msg.dataUrl) {
			rejectPhoto(msg.id, new Error("Photo result missing dataUrl"));
			return;
		}
		const parsed = parsePhotoDataUrl(msg.dataUrl);
		if (!parsed) {
			rejectPhoto(msg.id, new Error("Invalid photo data URL"));
			return;
		}
		resolvePhoto(msg.id, { dataUrl: msg.dataUrl, mimeType: parsed.mimeType, base64: parsed.base64 });
		return;
	}
	if (msg.type === "prompt") await harness.prompt(msg.text);
	if (msg.type === "abort") {
		resolveAllSpeech();
		rejectAllPhotos("Aborted");
		await harness.abort();
		broadcast({ type: "sim_motor", command: "stop", durationMs: 0 });
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	if (url.pathname === "/__version" && req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
		res.end(JSON.stringify({ version: serverVersion }));
		return;
	}
	if (url.pathname === "/api/client-log" && req.method === "POST") {
		try {
			logClientMessage(readRecord(await readRequestJson(req)) as unknown as ClientLogMsg);
			res.writeHead(204).end();
		} catch (error) {
			console.warn(`client log parse failed: ${error instanceof Error ? error.message : String(error)}`);
			res.writeHead(400).end();
		}
		return;
	}
	if (url.pathname === "/api/tts" && req.method === "GET") {
		try {
			await handleTtsRequest(url.searchParams.get("text") ?? "", url.searchParams.get("provider") ?? undefined, res);
		} catch (error) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		}
		return;
	}
	const path = url.pathname === "/" ? "/index.html" : url.pathname;
	const file = join(publicDir, path);
	if (!file.startsWith(publicDir)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const data = await readFile(file);
		const extension = extname(file);
		const contentType = extension === ".js" ? "text/javascript" : extension === ".css" ? "text/css" : "text/html";
		res.writeHead(200, {
			"content-type": contentType,
			"cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
			pragma: "no-cache",
			expires: "0",
		});
		if (extension === ".html") {
			res.end(
				data
					.toString("utf8")
					.replaceAll("style.css?v=dev", `style.css?v=${serverVersion}`)
					.replaceAll("app.js?v=dev", `app.js?v=${serverVersion}`),
			);
			return;
		}
		res.end(data);
	} catch {
		res.writeHead(404).end("not found");
	}
});

const wss = new WebSocketServer({ noServer: true });
const reloadWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const target = url.pathname === "/__reload" ? reloadWss : wss;
	target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

wss.on("connection", (ws, req: IncomingMessage) => {
	clients.add(ws);
	clientUserAgents.set(ws, req.headers["user-agent"] ?? "unknown");
	console.log(`[ws] client connected ua=${clientUserAgents.get(ws)}`);
	selectRobotClient(ws);
	ws.send(JSON.stringify({ type: "hello", motorLog }));
	ws.on("message", async (data, isBinary) => {
		try {
			if (isBinary) {
				handleAudioFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
				return;
			}
			await handleClientMessage(JSON.parse(String(data)) as ClientMsg);
		} catch (error) {
			ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
		}
	});
	ws.on("close", () => {
		console.log(`[ws] client disconnected ua=${clientUserAgents.get(ws) ?? "unknown"}`);
		clients.delete(ws);
		clientUserAgents.delete(ws);
		if (robotClient === ws) {
			robotClient = [...clients].find(isMobileRobotClient) ?? [...clients][0];
			if (robotClient)
				console.log(`[robot] selected fallback client ua=${clientUserAgents.get(robotClient) ?? "unknown"}`);
		}
		resolveSpeechForClient(ws);
		rejectPhotosForClient(ws);
	});
});

reloadWss.on("connection", () => {
	// The client reloads when this socket reconnects after the dev supervisor restarts the server.
});

server.listen(port, "0.0.0.0", () => console.log(`robot demo: http://localhost:${port}`));
