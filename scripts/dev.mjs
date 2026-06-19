import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import * as esbuild from "esbuild";

const root = process.cwd();
const watchedDirs = [resolve(root, "src"), resolve(root, "public")];
const ignoredFiles = new Set([resolve(root, "public/app.js")]);
let server;
let restartTimer;
let restarting = false;
let pendingRestart = false;

async function loadDotEnv() {
	try {
		const text = await readFile(resolve(root, ".env"), "utf8");
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq < 0) continue;
			const key = trimmed.slice(0, eq).trim();
			const value = trimmed.slice(eq + 1).trim();
			if (key && !(key in process.env)) process.env[key] = value;
		}
	} catch {
		// no .env file, fine
	}
}


function log(message) {
	console.log(`[dev] ${message}`);
}

async function compileClient() {
	await esbuild.build({
		entryPoints: [resolve(root, "src/client/index.ts")],
		bundle: true,
		format: "esm",
		target: "es2022",
		outfile: resolve(root, "public/app.js"),
	});
	log("client compiled");
}

function startServer() {
	server = spawn("node", ["--import", "tsx", resolve(root, "src/server/index.ts")], {
		cwd: root,
		env: process.env,
		stdio: "inherit",
	});
	server.on("exit", (code, signal) => {
		if (server) log(`server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
	});
	log("server started");
}

async function stopServer() {
	if (!server) return;
	const child = server;
	server = undefined;
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise((resolveStop) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, 2000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGTERM");
	});
}

async function restart(reason) {
	if (restarting) {
		pendingRestart = true;
		return;
	}
	restarting = true;
	try {
		log(`restart: ${reason}`);
		await stopServer();
		await compileClient();
		startServer();
	} catch (error) {
		console.error(error);
	} finally {
		restarting = false;
		if (pendingRestart) {
			pendingRestart = false;
			scheduleRestart("pending changes");
		}
	}
}

function scheduleRestart(reason) {
	if (restartTimer) clearTimeout(restartTimer);
	restartTimer = setTimeout(() => {
		restartTimer = undefined;
		restart(reason);
	}, 100);
}

function shouldIgnore(path) {
	return ignoredFiles.has(resolve(root, path));
}

for (const dir of watchedDirs) {
	watch(dir, { recursive: true }, (_eventType, filename) => {
		if (!filename) return;
		const path = resolve(dir, filename.toString());
		if (shouldIgnore(path)) return;
		scheduleRestart(path);
	});
	log(`watching ${dir}`);
}

process.on("SIGINT", async () => {
	await stopServer();
	process.exit(130);
});
process.on("SIGTERM", async () => {
	await stopServer();
	process.exit(143);
});

await loadDotEnv();
await restart("initial start");
