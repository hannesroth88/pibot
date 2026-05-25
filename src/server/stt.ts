import { type ChildProcess, spawn } from "node:child_process";

export interface SttServiceDeps {
	workerPath: string;
	onEvent?: (event: SttEvent) => void;
}

export interface SttService {
	onEvent: (handler: (event: SttEvent) => void) => void;
	handleAudioFrame: (data: Buffer) => void;
	stopChildProcess: () => void;
}

export type SttEvent =
	| { type: "loading" }
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			prerollMs: number;
			interimIntervalMs?: number;
	  }
	| { type: "worker_log"; line: string }
	| { type: "worker_exit"; code: number | null; signal: string | null }
	| { type: "parse_error"; line: string; message: string }
	| { type: "speech_start"; index: number }
	| { type: "speech_end"; index: number; duration: number }
	| { type: "speech_drop"; index: number; duration: number; reason: string }
	| { type: "interim"; index: number; text: string; audioMs: number; decodeMs: number }
	| { type: "stop_detected"; index: number; text: string; source: "interim" | "final" }
	| { type: "final"; index: number; text: string; decodeMs: number }
	| { type: "error"; message: string };

type SttWorkerMsg =
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			speechPadMs: number;
			prerollMs: number;
			interimIntervalMs?: number;
	  }
	| { type: "speech_start"; index: number; time: number }
	| { type: "speech_end"; index: number; duration: number }
	| { type: "speech_drop"; index: number; duration: number; reason: string }
	| { type: "interim"; index: number; text: string; audioMs: number; decodeMs: number }
	| { type: "final"; index: number; text: string; duration: number; decodeMs: number }
	| { type: "error"; message: string };

const stopWordPhrases = [
	"stop",
	"stopp",
	"halt",
	"anhalten",
	"abbrechen",
	"schluss",
	"ruhe",
	"sei still",
	"sei ruhig",
	"hör auf",
	"hoer auf",
];

function looksLikeStopCommand(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[.,!?;:()[\]{}"'`´]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) return false;
	for (const phrase of stopWordPhrases) {
		if (normalized === phrase) return true;
		if (normalized.startsWith(`${phrase} `)) return true;
		if (normalized.endsWith(` ${phrase}`)) return true;
		if (normalized.includes(` ${phrase} `)) return true;
	}
	return false;
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

export function createSttService(deps: SttServiceDeps): SttService {
	let process: ChildProcess | undefined;
	let stdout = "";
	let stoppedUtteranceIndex: number | undefined;
	const eventHandlers: Array<(event: SttEvent) => void> = deps.onEvent ? [deps.onEvent] : [];
	let latestLifecycleEvent: SttEvent | undefined;
	const emit = (event: SttEvent) => {
		if (event.type === "loading" || event.type === "ready" || event.type === "error") latestLifecycleEvent = event;
		for (const handler of eventHandlers) handler(event);
	};

	function startWorker(): void {
		if (process && !process.killed) return;
		stdout = "";
		emit({ type: "loading" });
		const child = spawn("uvx", ["--with", "parakeet-mlx", "--with", "silero-vad", "python", deps.workerPath], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		process = child;
		child.stdout?.on("data", (data: Buffer) => handleStdout(data));
		streamLines(child.stderr, (line) => emit({ type: "worker_log", line }));
		child.once("error", (error) => emit({ type: "error", message: error.message }));
		child.once("exit", (code, signal) => {
			if (process === child) process = undefined;
			emit({ type: "worker_exit", code, signal });
		});
	}

	function handleStdout(data: Buffer): void {
		stdout += data.toString("utf8");
		while (true) {
			const newline = stdout.indexOf("\n");
			if (newline < 0) return;
			const line = stdout.slice(0, newline).trim();
			stdout = stdout.slice(newline + 1);
			if (!line) continue;
			try {
				handleMessage(JSON.parse(line) as SttWorkerMsg);
			} catch (error) {
				emit({ type: "parse_error", line, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	function handleMessage(message: SttWorkerMsg): void {
		if (message.type === "ready") {
			emit({
				type: "ready",
				sampleRate: message.sampleRate,
				vadChunkMs: message.vadChunkMs,
				vadThreshold: message.vadThreshold,
				minSilenceMs: message.minSilenceMs,
				prerollMs: message.prerollMs,
				interimIntervalMs: message.interimIntervalMs,
			});
			return;
		}
		if (message.type === "speech_start") {
			stoppedUtteranceIndex = undefined;
			emit({ type: "speech_start", index: message.index });
			return;
		}
		if (message.type === "speech_end") {
			emit({ type: "speech_end", index: message.index, duration: message.duration });
			return;
		}
		if (message.type === "speech_drop") {
			emit({ type: "speech_drop", index: message.index, duration: message.duration, reason: message.reason });
			return;
		}
		if (message.type === "interim") {
			const text = message.text.trim();
			emit({ type: "interim", index: message.index, text, audioMs: message.audioMs, decodeMs: message.decodeMs });
			if (text && looksLikeStopCommand(text) && stoppedUtteranceIndex !== message.index) {
				stoppedUtteranceIndex = message.index;
				emit({ type: "stop_detected", index: message.index, text, source: "interim" });
			}
			return;
		}
		if (message.type === "final") {
			const text = message.text.trim();
			if (!text) {
				emit({ type: "final", index: message.index, text, decodeMs: message.decodeMs });
				return;
			}
			if (stoppedUtteranceIndex === message.index) return;
			if (looksLikeStopCommand(text)) {
				stoppedUtteranceIndex = message.index;
				emit({ type: "stop_detected", index: message.index, text, source: "final" });
				return;
			}
			emit({ type: "final", index: message.index, text, decodeMs: message.decodeMs });
			return;
		}
		emit({ type: "error", message: message.message });
	}

	function handleAudioFrame(data: Buffer): void {
		if (!process?.stdin || process.stdin.destroyed) return;
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32LE(data.byteLength, 0);
		process.stdin.write(header);
		process.stdin.write(data);
	}

	function stopChildProcess(): void {
		process?.kill();
	}

	startWorker();
	return {
		onEvent: (handler) => {
			eventHandlers.push(handler);
			if (latestLifecycleEvent) handler(latestLifecycleEvent);
		},
		handleAudioFrame,
		stopChildProcess,
	};
}
