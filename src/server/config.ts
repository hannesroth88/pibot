import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL(".", import.meta.url));

export const serverConfig = {
	publicDir: resolve(serverDir, "../../public"),
	pibotCacheDir: process.env.PIBOT_CACHE_DIR ?? resolve(homedir(), ".cache/pibot"),
	port: Number(process.env.PORT ?? 8010),
	host: process.env.HOST ?? "127.0.0.1",
	sttWorkerBinaryPath: resolve(
		serverDir,
		`../../native/pibot-stt/target/release/pibot-stt-worker${process.platform === "win32" ? ".exe" : ""}`,
	),
	parakeetTdtModelDir:
		process.env.PARAKEET_TDT_MODEL_DIR ?? resolve(homedir(), "models/parakeet-tdt-0.6b-v3-onnx-int8"),
	llamaBaseUrl: process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080/v1",
	llamaHost: process.env.LLAMA_HOST ?? "127.0.0.1",
	llamaPort: Number(process.env.LLAMA_PORT ?? 8080),
	llamaContextWindow: Number(process.env.LLAMA_CONTEXT_WINDOW ?? 131072),
	llamaModelDir: process.env.LLAMA_MODEL_DIR ?? resolve(homedir(), "models/qwen3.6-35b-a3b"),
	qwen3TtsWorkerPath: resolve(serverDir, "../../scripts/qwen3-tts-worker.py"),
	version: String(Date.now()),
	maxContextImages: Number(process.env.MAX_CONTEXT_IMAGES ?? 4),
	memoryFile: process.env.MEMORY_FILE ?? "data/memories.json",
};
