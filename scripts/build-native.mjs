#!/usr/bin/env node

import { spawn } from "node:child_process";

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} exited code=${code ?? "none"} signal=${signal ?? "none"}`));
		});
	});
}

await run("npm", ["run", "build:stt-parakeet-cpp"]);

if (process.platform === "darwin") {
	await run("npm", ["run", "build:tts-rust"]);
} else {
	console.log("Skipping Qwen3-TTS native build: Rust/MLX worker is macOS-only.");
}
