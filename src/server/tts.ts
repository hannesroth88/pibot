import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type Dirent, existsSync } from "node:fs";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";

const workerInputSpeak = 1;
const workerInputShutdown = 3;
const workerOutputReady = 1;
const workerOutputAudioStart = 2;
const workerOutputAudioChunk = 3;
const workerOutputAudioDone = 4;
const workerOutputError = 5;
const frameHeaderBytes = 9;
const defaultRustTtsModelRepo = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
const ignoredHuggingFaceFiles = new Set([".gitattributes", "README.md"]);
const requiredRustTtsModelFiles = [
	"config.json",
	"model.safetensors",
	"vocab.json",
	"merges.txt",
	"speech_tokenizer/model.safetensors",
] as const;

type TtsWorkerKind = "python" | "rust";

export interface TtsServiceDeps {
	workerKind: string;
	pythonCommand: string;
	pythonWorkerPath: string;
	rustWorkerPath: string | undefined;
	rustModelPath: string | undefined;
	logger: Logger;
}

export interface TtsCallbacks {
	onStart: (sampleRate: number) => void;
	onAudio: (pcm: Uint8Array) => void;
	onDone: () => void;
	onError: (message: string) => void;
}

export interface TtsService {
	ready: Promise<void>;
	start: (userId: string, callbacks: TtsCallbacks) => void;
	pushText: (userId: string, text: string) => void;
	end: (userId: string) => void;
	cancelUser: (userId: string, reason: string) => void;
	cancel: (reason: string) => void;
	stop: () => void;
}

interface QueuedRequest {
	id: number;
	userId: string;
	text: string;
}

interface ActiveRequest extends QueuedRequest {
	cancelled: boolean;
}

interface TtsTurn {
	callbacks: TtsCallbacks;
	pendingRequests: number;
	turnEnded: boolean;
	streamStarted: boolean;
	cancelled: boolean;
}

interface DownloadFile {
	url: string;
	path: string;
	label: string;
}

function envNumber(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
	return parsed;
}

function makeFrame(type: number, id: number, payload: Uint8Array = new Uint8Array()): Buffer {
	const frame = Buffer.allocUnsafe(frameHeaderBytes + payload.byteLength);
	frame.writeUInt8(type, 0);
	frame.writeUInt32LE(id >>> 0, 1);
	frame.writeUInt32LE(payload.byteLength, 5);
	Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(frame, frameHeaderBytes);
	return frame;
}

function decodeUtf8(payload: Uint8Array): string {
	return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8");
}

function parseWorkerKind(value: string): TtsWorkerKind {
	if (value === "python" || value === "rust") return value;
	throw new Error(`QWEN3_TTS_WORKER must be python or rust, got ${value}`);
}

function shouldLogQwen3Line(line: string): boolean {
	if (line.startsWith("{")) return true;
	if (/^(ready|cancel:|error|failed|traceback)/i.test(line)) return true;
	if (
		/^(ICL voice clone|Reference text:|Synthesis text:|Reference codec frames:|ref_text tokens:|Building ICL|Built ICL|Generating audio codes|Generated \d+ code frames|Streaming decode|Streaming codes tensor shape:|Streaming vocoder output shape:|EOS detected)/.test(
			line,
		)
	) {
		return false;
	}
	if (/^(Loaded|Loading|Found |Audio encoder input:|After |Before |Encoded codes:|Encoded \d+ frames)/.test(line))
		return false;
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function huggingFaceFileUrl(repo: string, file: string): string {
	return `https://huggingface.co/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
}

async function hasUsableFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).size > 0;
	} catch {
		return false;
	}
}

async function hasRequiredRustTtsModelFiles(modelDir: string): Promise<boolean> {
	for (const file of requiredRustTtsModelFiles) {
		if (!(await hasUsableFile(join(modelDir, file)))) return false;
	}
	return true;
}

async function listHuggingFaceFiles(repo: string): Promise<string[]> {
	const response = await fetch(`https://huggingface.co/api/models/${repo}`);
	if (!response.ok) throw new Error(`failed to list ${repo}: HTTP ${response.status}`);
	const value: unknown = await response.json();
	if (!isRecord(value) || !Array.isArray(value.siblings))
		throw new Error(`invalid Hugging Face model API response for ${repo}`);
	const files: string[] = [];
	for (const sibling of value.siblings) {
		if (!isRecord(sibling) || typeof sibling.rfilename !== "string") continue;
		files.push(sibling.rfilename);
	}
	return files;
}

async function downloadFile(file: DownloadFile, logger: Logger): Promise<void> {
	const tmpPath = `${file.path}.tmp-${process.pid}`;
	await unlink(tmpPath).catch(() => undefined);
	await mkdir(dirname(file.path), { recursive: true });
	logger.log(`downloading ${file.label}`);
	const response = await fetch(file.url);
	if (!response.ok || !response.body) throw new Error(`failed to download ${file.label}: HTTP ${response.status}`);
	const total = Number(response.headers.get("content-length") ?? "0");
	const reader = response.body.getReader();
	const output = createWriteStream(tmpPath, { flags: "wx" });
	let received = 0;
	let lastLog = Date.now();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			received += chunk.value.byteLength;
			if (!output.write(chunk.value)) await once(output, "drain");
			if (Date.now() - lastLog > 5000) {
				lastLog = Date.now();
				const suffix = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)} MiB` : "";
				logger.log(`downloading ${file.label}: ${(received / 1024 / 1024).toFixed(1)} MiB${suffix}`);
			}
		}
		output.end();
		await once(output, "finish");
		await rename(tmpPath, file.path);
		const suffix = total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)} MiB` : "";
		logger.log(`downloaded ${file.label}: ${(received / 1024 / 1024).toFixed(1)} MiB${suffix}`);
	} catch (error) {
		output.destroy();
		await unlink(tmpPath).catch(() => undefined);
		throw error;
	}
}

async function cleanupStaleDownloads(dir: string): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await cleanupStaleDownloads(path);
			continue;
		}
		if (entry.isFile() && entry.name.includes(".tmp-")) await unlink(path).catch(() => undefined);
	}
}

async function ensureRustTtsModel(modelDir: string, logger: Logger): Promise<void> {
	await mkdir(modelDir, { recursive: true });
	await cleanupStaleDownloads(modelDir);
	if (await hasRequiredRustTtsModelFiles(modelDir)) return;

	const repo = process.env.QWEN3_TTS_RUST_MODEL_REPO ?? defaultRustTtsModelRepo;
	logger.log(`provisioning Rust Qwen3 TTS model ${repo} into ${modelDir}`);
	const files = (await listHuggingFaceFiles(repo)).filter((file) => !ignoredHuggingFaceFiles.has(file));
	for (const file of files) {
		const path = join(modelDir, file);
		if (await hasUsableFile(path)) continue;
		await downloadFile({ url: huggingFaceFileUrl(repo, file), path, label: `Qwen3 TTS model file ${file}` }, logger);
	}

	if (!(await hasRequiredRustTtsModelFiles(modelDir))) {
		throw new Error(`Rust Qwen3 TTS model is incomplete after download: ${modelDir}`);
	}
}

export function createTtsService(deps: TtsServiceDeps): TtsService {
	const workerKind = parseWorkerKind(deps.workerKind);
	const qwen3ModelName = process.env.QWEN3_TTS_MODEL_NAME ?? "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-6bit";
	const qwen3RefAudio = process.env.QWEN3_TTS_REF_AUDIO ?? "data/voices/elevenlabs-pibot-reference-de.wav";
	const qwen3RefTextFile = process.env.QWEN3_TTS_REF_TEXT_FILE ?? "data/voices/elevenlabs-pibot-reference-de.txt";
	const qwen3Language = process.env.QWEN3_TTS_LANGUAGE ?? "de";
	const qwen3OutputSampleRate = envNumber("QWEN3_TTS_OUTPUT_SAMPLE_RATE", 24000);
	const qwen3Temperature = envNumber("QWEN3_TTS_TEMPERATURE", 0.7);
	const qwen3TopK = envNumber("QWEN3_TTS_TOP_K", 30);
	const qwen3Seed = process.env.QWEN3_TTS_SEED ?? "1234";

	const logger = deps.logger.tag("tts");
	const qwen3Logger = logger.tag("qwen3");
	const textEncoder = new TextEncoder();
	const queue: QueuedRequest[] = [];
	const turns = new Map<string, TtsTurn>();
	let worker: ChildProcess | undefined;
	let stdoutBuffer = Buffer.alloc(0);
	let nextRequestId = 1;
	let activeRequest: ActiveRequest | undefined;
	let resolveReady: (() => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;

	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	function sendFrame(type: number, id: number, payload?: Uint8Array): void {
		if (!worker?.stdin || worker.stdin.destroyed) throw new Error("Qwen3 TTS worker is not available");
		worker.stdin.write(makeFrame(type, id, payload));
	}

	function userHasQueuedRequest(userId: string): boolean {
		return queue.some((request) => request.userId === userId) || activeRequest?.userId === userId;
	}

	function finishTurnIfIdle(userId: string): void {
		const turn = turns.get(userId);
		if (!turn || !turn.turnEnded || turn.pendingRequests > 0 || userHasQueuedRequest(userId)) return;
		turns.delete(userId);
		turn.callbacks.onDone();
	}

	function failTurn(userId: string, message: string): void {
		const turn = turns.get(userId);
		if (!turn) return;
		turns.delete(userId);
		turn.callbacks.onError(message);
	}

	function pump(): void {
		if (activeRequest) return;
		const request = queue.shift();
		if (!request) return;
		activeRequest = { ...request, cancelled: false };
		try {
			sendFrame(workerInputSpeak, request.id, textEncoder.encode(request.text));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			activeRequest = undefined;
			failTurn(request.userId, message);
			pump();
		}
	}

	function handleWorkerFrame(type: number, id: number, payload: Uint8Array): void {
		if (type === workerOutputReady) {
			qwen3Logger.log("ready");
			resolveReady?.();
			resolveReady = undefined;
			return;
		}
		const request = activeRequest;
		if (!request || id !== request.id) return;
		const turn = turns.get(request.userId);
		if (request.cancelled) {
			if (type === workerOutputAudioDone || type === workerOutputError) {
				activeRequest = undefined;
				pump();
			}
			return;
		}
		if (!turn || turn.cancelled) {
			if (type === workerOutputAudioDone || type === workerOutputError) {
				if (turn) turns.delete(request.userId);
				activeRequest = undefined;
				pump();
			}
			return;
		}
		if (type === workerOutputAudioStart) {
			if (!turn.streamStarted) {
				turn.streamStarted = true;
				const sampleRate = payload.byteLength >= 4 ? Buffer.from(payload).readUInt32LE(0) : qwen3OutputSampleRate;
				turn.callbacks.onStart(sampleRate);
			}
			return;
		}
		if (type === workerOutputAudioChunk) {
			turn.callbacks.onAudio(payload);
			return;
		}
		if (type === workerOutputAudioDone) {
			turn.pendingRequests = Math.max(0, turn.pendingRequests - 1);
			activeRequest = undefined;
			finishTurnIfIdle(request.userId);
			pump();
			return;
		}
		if (type === workerOutputError) {
			activeRequest = undefined;
			failTurn(request.userId, decodeUtf8(payload));
			pump();
		}
	}

	function handleStdoutData(chunk: Buffer): void {
		stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
		while (stdoutBuffer.byteLength >= frameHeaderBytes) {
			const type = stdoutBuffer.readUInt8(0);
			const id = stdoutBuffer.readUInt32LE(1);
			const payloadLength = stdoutBuffer.readUInt32LE(5);
			const frameLength = frameHeaderBytes + payloadLength;
			if (stdoutBuffer.byteLength < frameLength) return;
			const payload = stdoutBuffer.subarray(frameHeaderBytes, frameLength);
			stdoutBuffer = stdoutBuffer.subarray(frameLength);
			handleWorkerFrame(type, id, payload);
		}
	}

	function workerCommand(): { command: string; args: string[]; label: string } {
		const commonArgs = [
			"--serve",
			"--ref-audio",
			qwen3RefAudio,
			"--ref-text-file",
			qwen3RefTextFile,
			"--language",
			qwen3Language,
			"--output-sample-rate",
			String(qwen3OutputSampleRate),
			"--temperature",
			String(qwen3Temperature),
			"--top-k",
			String(qwen3TopK),
		];
		if (qwen3Seed.trim()) commonArgs.push("--seed", qwen3Seed);
		if (workerKind === "python") {
			const directArgs = [deps.pythonWorkerPath, ...commonArgs, "--model-name", qwen3ModelName];
			if (deps.pythonCommand === "uv") {
				const args = ["run", "--no-project", "--with", "speech-to-speech==0.2.9", "python", ...directArgs];
				return { command: deps.pythonCommand, args, label: `${deps.pythonCommand} ${args.join(" ")}` };
			}
			return {
				command: deps.pythonCommand,
				args: directArgs,
				label: `${deps.pythonCommand} ${directArgs.join(" ")}`,
			};
		}
		if (!deps.rustWorkerPath) throw new Error("QWEN3_TTS_RUST_WORKER_PATH is required when QWEN3_TTS_WORKER=rust");
		if (!existsSync(deps.rustWorkerPath)) {
			throw new Error(`Rust Qwen3 TTS worker binary missing: ${deps.rustWorkerPath}. Run npm run build:tts-rust.`);
		}
		const args = [...commonArgs];
		const rustModelPath = deps.rustModelPath ?? process.env.QWEN3_TTS_MODEL_NAME;
		if (!rustModelPath) throw new Error("QWEN3_TTS_RUST_MODEL_PATH is required when QWEN3_TTS_WORKER=rust");
		args.push("--model-name", rustModelPath);
		return { command: deps.rustWorkerPath, args, label: `${deps.rustWorkerPath} ${args.join(" ")}` };
	}

	async function startWorkerAsync(): Promise<void> {
		if (workerKind === "rust") {
			const rustModelPath = deps.rustModelPath ?? process.env.QWEN3_TTS_MODEL_NAME;
			if (!rustModelPath) throw new Error("QWEN3_TTS_RUST_MODEL_PATH is required when QWEN3_TTS_WORKER=rust");
			await ensureRustTtsModel(rustModelPath, logger);
		}
		const { command, args, label } = workerCommand();
		logger.log(`starting Qwen3 TTS ${workerKind} worker: ${label}`);
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		worker = child;
		child.stdout?.on("data", (chunk: Buffer) => handleStdoutData(chunk));
		child.stderr?.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed && shouldLogQwen3Line(trimmed)) qwen3Logger.log(trimmed);
			}
		});
		child.once("error", (error) => {
			rejectReady?.(error);
			for (const userId of turns.keys()) failTurn(userId, error.message);
		});
		child.once("exit", (code, signal) => {
			if (worker === child) worker = undefined;
			const error = new Error(`Qwen3 TTS worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
			rejectReady?.(error);
			for (const userId of turns.keys()) failTurn(userId, error.message);
			if (code !== 0) logger.log(error.message);
		});
	}

	function startWorker(): void {
		void startWorkerAsync().catch((error) => {
			const normalized = error instanceof Error ? error : new Error(String(error));
			logger.log(normalized.message);
			rejectReady?.(normalized);
			for (const userId of turns.keys()) failTurn(userId, normalized.message);
		});
	}

	function start(userId: string, nextCallbacks: TtsCallbacks): void {
		cancelUser(userId, "new TTS stream");
		turns.set(userId, {
			callbacks: nextCallbacks,
			pendingRequests: 0,
			turnEnded: false,
			streamStarted: false,
			cancelled: false,
		});
	}

	function pushText(userId: string, text: string): void {
		const turn = turns.get(userId);
		const trimmed = text.trim();
		if (!turn || !trimmed) return;
		const request = { id: nextRequestId++, userId, text: trimmed };
		turn.pendingRequests++;
		queue.push(request);
		pump();
	}

	function end(userId: string): void {
		const turn = turns.get(userId);
		if (!turn) return;
		turn.turnEnded = true;
		if (!turn.streamStarted && !userHasQueuedRequest(userId)) turn.callbacks.onStart(qwen3OutputSampleRate);
		finishTurnIfIdle(userId);
	}

	function cancelUser(userId: string, reason: string): void {
		qwen3Logger.log(`cancel ${userId}: ${reason}`);
		const turn = turns.get(userId);
		if (turn) turn.cancelled = true;
		let removed = 0;
		for (let i = queue.length - 1; i >= 0; i--) {
			const request = queue[i];
			if (request?.userId !== userId) continue;
			queue.splice(i, 1);
			removed++;
		}
		if (turn) turn.pendingRequests = Math.max(0, turn.pendingRequests - removed);
		if (activeRequest?.userId === userId) activeRequest.cancelled = true;
		turns.delete(userId);
	}

	function cancel(reason: string): void {
		qwen3Logger.log(`cancel all: ${reason}`);
		for (const userId of [...turns.keys()]) cancelUser(userId, reason);
		queue.length = 0;
	}

	function stop(): void {
		try {
			sendFrame(workerInputShutdown, 0);
		} catch {
			// process may already be gone
		}
		worker?.kill();
	}

	startWorker();

	return { ready, start, pushText, end, cancelUser, cancel, stop };
}
