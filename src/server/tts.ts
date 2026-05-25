import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { createEventEmitter, type EventSource } from "./events.js";

type TtsProvider = "elevenlabs" | "pocket";

export type TtsEvent =
	| { type: "speech_registered"; id: string; chars: number }
	| { type: "speech_resolved"; id: string }
	| { type: "pocket_starting"; command: string }
	| { type: "pocket_ready"; url: string }
	| { type: "pocket_log"; line: string }
	| { type: "pocket_error"; message: string }
	| { type: "pocket_exit"; code: number | null; signal: string | null }
	| { type: "elevenlabs_voice_lookup_failed"; message: string };

export interface TtsServiceDeps {
	onEvent?: (event: TtsEvent) => void | Promise<void>;
}

export interface TtsService extends EventSource<TtsEvent> {
	fetchTtsAudio: (
		id: string,
		providerValue: string | undefined,
	) => Promise<{ response: Response; contentType: string }>;
	registerSpeech: (text: string) => { id: string; url: string } | undefined;
	resolveSpeech: (id: string) => void;
	resolveAllSpeech: () => void;
	stopChildProcess: () => void;
}

function streamLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
	if (!stream) return;
	let buffered = "";
	stream.on("data", (chunk: Buffer | string) => {
		buffered += chunk.toString();
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line) onLine(line);
		}
	});
	stream.on("end", () => {
		const line = buffered.trim();
		buffered = "";
		if (line) onLine(line);
	});
}

export function createTtsService(deps: TtsServiceDeps = {}): TtsService {
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

	const events = createEventEmitter<TtsEvent>(deps.onEvent ? [deps.onEvent] : []);
	const pendingSpeech = new Map<string, { text: string }>();
	let pocketTtsProcess: ChildProcess | undefined;
	let pocketTtsStartPromise: Promise<void> | undefined;
	let pocketTtsLastError: Error | undefined;

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
		const command = `uvx pocket-tts serve --language ${pocketTtsLanguage} --host ${pocketTtsBindHost} --port ${pocketTtsPort}`;
		events.emit({ type: "pocket_starting", command });
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
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		pocketTtsProcess = child;
		streamLines(child.stdout, (line) => events.emit({ type: "pocket_log", line }));
		streamLines(child.stderr, (line) => events.emit({ type: "pocket_log", line }));
		child.once("error", (error) => {
			pocketTtsLastError = error;
			events.emit({ type: "pocket_error", message: error.message });
		});
		child.once("exit", (code, signal) => {
			if (pocketTtsProcess === child) pocketTtsProcess = undefined;
			if (code !== 0) events.emit({ type: "pocket_exit", code, signal });
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
					events.emit({ type: "pocket_ready", url: pocketTtsUrl });
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

	function parseTtsProvider(value: string | undefined): TtsProvider {
		if (value === undefined || value === "elevenlabs") return "elevenlabs";
		if (value === "pocket") return "pocket";
		throw new Error(`Unknown TTS provider: ${value}`);
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
			events.emit({
				type: "elevenlabs_voice_lookup_failed",
				message: error instanceof Error ? error.message : String(error),
			});
			return elevenLabsVoiceId;
		}
	}

	async function fetchPocketTts(text: string): Promise<{ response: Response; contentType: string }> {
		await ensurePocketTtsStarted();
		const form = new FormData();
		form.set("text", text);
		form.set("voice_url", pocketTtsVoice);
		return { response: await fetch(pocketTtsUrl, { method: "POST", body: form }), contentType: "audio/wav" };
	}

	async function fetchElevenLabsTts(text: string): Promise<{ response: Response; contentType: string }> {
		if (!elevenLabsApiKey) throw new Error("ELEVENLABS_API_KEY missing");
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
		return { response, contentType: "audio/mpeg" };
	}

	async function fetchTts(
		id: string,
		providerValue: string | undefined,
	): Promise<{ response: Response; contentType: string }> {
		const pending = pendingSpeech.get(id);
		if (!pending) throw new Error("speech not found");
		const provider = parseTtsProvider(providerValue ?? defaultTtsProvider);
		return provider === "pocket" ? await fetchPocketTts(pending.text) : await fetchElevenLabsTts(pending.text);
	}

	function resolveSpeech(id: string): void {
		if (!pendingSpeech.delete(id)) return;
		events.emit({ type: "speech_resolved", id });
	}

	function resolveAllSpeech(): void {
		for (const id of pendingSpeech.keys()) resolveSpeech(id);
	}

	function registerSpeech(text: string): { id: string; url: string } | undefined {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const id = randomUUID();
		pendingSpeech.set(id, { text: trimmed });
		events.emit({ type: "speech_registered", id, chars: trimmed.length });
		return { id, url: `/api/tts?id=${encodeURIComponent(id)}` };
	}

	function stopChildProcess(): void {
		pocketTtsProcess?.kill();
	}

	return {
		onEvent: events.onEvent,
		fetchTtsAudio: fetchTts,
		registerSpeech,
		resolveSpeech,
		resolveAllSpeech,
		stopChildProcess,
	};
}
