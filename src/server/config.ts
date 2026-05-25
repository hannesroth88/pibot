import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL(".", import.meta.url));

export const serverConfig = {
	publicDir: resolve(serverDir, "../../public"),
	port: Number(process.env.PORT ?? 8010),
	host: process.env.HOST ?? "127.0.0.1",
	parakeetSttWorkerPath: resolve(serverDir, "../../scripts/parakeet-stt-worker.py"),
	version: String(Date.now()),
	maxContextImages: Number(process.env.MAX_CONTEXT_IMAGES ?? 4),
	memoryFile: process.env.MEMORY_FILE ?? "data/memories.json",
};
