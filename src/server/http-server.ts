import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";

export interface HttpServer {
	server: Server;
}

function contentTypeFor(file: string): string {
	const extension = extname(file);
	if (extension === ".js") return "text/javascript; charset=utf-8";
	if (extension === ".css") return "text/css; charset=utf-8";
	return "text/html; charset=utf-8";
}

async function writeAudioResponse(response: Response, contentType: string, res: ServerResponse): Promise<void> {
	if (!response.ok || !response.body) {
		res.writeHead(response.status || 502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: await response.text() }));
		return;
	}
	res.writeHead(200, {
		"content-type": response.headers.get("content-type") ?? contentType,
		"cache-control": "no-store",
	});
	for await (const chunk of response.body as AsyncIterable<Uint8Array>) res.write(chunk);
	res.end();
}

async function serveStaticFile(
	req: IncomingMessage,
	res: ServerResponse,
	publicDir: string,
	version: string,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const path = url.pathname === "/" ? "/index.html" : url.pathname;
	const file = join(publicDir, path);
	if (!file.startsWith(publicDir)) {
		res.writeHead(403).end();
		return;
	}
	try {
		const data = await readFile(file);
		const extension = extname(file);
		res.writeHead(200, {
			"content-type": contentTypeFor(file),
			"cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
			pragma: "no-cache",
			expires: "0",
		});
		if (extension === ".html") {
			res.end(
				data
					.toString("utf8")
					.replaceAll("style.css?v=dev", `style.css?v=${version}`)
					.replaceAll("app.js?v=dev", `app.js?v=${version}`),
			);
			return;
		}
		res.end(data);
	} catch {
		res.writeHead(404).end("not found");
	}
}

export function createHttpServer(deps: {
	publicDir: string;
	version: string;
	fetchTtsAudio: (
		id: string,
		providerValue: string | undefined,
	) => Promise<{ response: Response; contentType: string }>;
}): HttpServer {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		if (url.pathname === "/__version" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ version: deps.version }));
			return;
		}
		if (url.pathname === "/api/tts" && req.method === "GET") {
			try {
				const audio = await deps.fetchTtsAudio(
					url.searchParams.get("id") ?? "",
					url.searchParams.get("provider") ?? undefined,
				);
				await writeAudioResponse(audio.response, audio.contentType, res);
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
			}
			return;
		}
		await serveStaticFile(req, res, deps.publicDir, deps.version);
	});
	return { server };
}
