import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage } from "../types.js";
import { createEventEmitter, type EventSource } from "./events.js";

export type WebsocketEvent =
	| { type: "client_connected"; client: WebSocket }
	| { type: "client_disconnected"; client: WebSocket }
	| { type: "client_rejected"; reason: string }
	| { type: "audio_frame"; data: Buffer }
	| { type: "client_message"; message: ClientMessage }
	| { type: "message_error"; message: string };

export interface WebsocketServer extends EventSource<WebsocketEvent> {
	broadcast: (message: object) => void;
}

export function attachWebSockets(deps: {
	server: Server;
	onEvent?: (event: WebsocketEvent) => void | Promise<void>;
}): WebsocketServer {
	let activeClient: WebSocket | undefined;
	const events = createEventEmitter<WebsocketEvent>(deps.onEvent ? [deps.onEvent] : []);
	const robotWss = new WebSocketServer({ noServer: true });
	const reloadWss = new WebSocketServer({ noServer: true });

	deps.server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const target = url.pathname === "/__reload" ? reloadWss : robotWss;
		target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
	});

	robotWss.on("connection", (ws) => {
		if (activeClient?.readyState === WebSocket.OPEN) {
			const reason = "Only one client may connect";
			events.emit({ type: "client_rejected", reason });
			ws.close(1008, reason);
			return;
		}
		activeClient = ws;
		events.emit({ type: "client_connected", client: ws });
		ws.on("message", (data, isBinary) => {
			try {
				if (isBinary) {
					events.emit({
						type: "audio_frame",
						data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
					});
					return;
				}
				events.emit({ type: "client_message", message: JSON.parse(String(data)) as ClientMessage });
			} catch (error) {
				events.emit({ type: "message_error", message: error instanceof Error ? error.message : String(error) });
			}
		});
		ws.on("close", () => {
			if (activeClient === ws) activeClient = undefined;
			events.emit({ type: "client_disconnected", client: ws });
		});
	});

	reloadWss.on("connection", () => {
		// The client reloads when this socket reconnects after the dev supervisor restarts the server.
	});

	return {
		onEvent: events.onEvent,
		broadcast: (message: object) => {
			if (activeClient?.readyState === WebSocket.OPEN) activeClient.send(JSON.stringify(message));
		},
	};
}
