import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { ClientMessage, RobotRpcMap, RobotRpcType, RobotWireResponse } from "../types.js";

type RobotRpcResponse = RobotRpcMap[RobotRpcType]["response"];

interface PendingRobotRequest {
	requestType: RobotRpcType;
	resolve: (value: RobotRpcResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout | undefined;
}

export class RobotClient {
	private current: WebSocket | undefined;
	private readonly pending = new Map<string, PendingRobotRequest>();
	private readonly heartbeat: NodeJS.Timeout;

	constructor() {
		this.heartbeat = setInterval(() => this.checkConnection(), 5000);
	}

	setWebSocket(client: WebSocket): void {
		if (this.current?.readyState === WebSocket.OPEN) return;
		this.current = client;
		client.once("close", () => this.clearWebSocket(client));
		client.once("error", () => this.clearWebSocket(client));
	}

	private clearWebSocket(client: WebSocket): void {
		if (this.current !== client) return;
		this.current = undefined;
		this.rejectAll("Robot client disconnected");
	}

	handleMessage(msg: ClientMessage): boolean {
		if (msg.type !== "robot_response") return false;
		this.resolveResponse(msg);
		return true;
	}

	async execute<const T extends RobotRpcType>(request: {
		type: T;
		payload: RobotRpcMap[T]["request"];
		timeoutMs: number | null;
	}): Promise<RobotRpcMap[T]["response"]> {
		const client = this.current;
		if (!client || client.readyState !== WebSocket.OPEN) throw new Error("Robot client not connected");
		const id = randomUUID();
		client.send(JSON.stringify({ type: "robot_request", id, request }));
		return await new Promise<RobotRpcMap[T]["response"]>((resolve, reject) => {
			const timeout =
				request.timeoutMs === null
					? undefined
					: setTimeout(() => {
							this.rejectPending(id, new Error(`Robot request timed out: ${request.type}`));
						}, request.timeoutMs);
			this.pending.set(id, {
				requestType: request.type,
				resolve: (value) => resolve(value as RobotRpcMap[T]["response"]),
				reject,
				timeout,
			});
		});
	}

	rejectAll(reason: string): void {
		for (const id of this.pending.keys()) this.rejectPending(id, new Error(reason));
	}

	stop(): void {
		clearInterval(this.heartbeat);
		this.rejectAll("Robot client stopped");
	}

	private resolveResponse(response: RobotWireResponse): void {
		const pending = this.pending.get(response.id);
		if (!pending) return;
		if (pending.requestType !== response.requestType) {
			this.rejectPending(
				response.id,
				new Error(`Robot response type mismatch: expected ${pending.requestType}, got ${response.requestType}`),
			);
			return;
		}
		if (pending.timeout) clearTimeout(pending.timeout);
		this.pending.delete(response.id);
		if (response.error) {
			pending.reject(new Error(response.error));
			return;
		}
		if (response.payload === undefined) {
			pending.reject(new Error(`Robot response missing payload: ${response.requestType}`));
			return;
		}
		pending.resolve(response.payload);
	}

	private rejectPending(id: string, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		if (pending.timeout) clearTimeout(pending.timeout);
		this.pending.delete(id);
		pending.reject(error);
	}

	private checkConnection(): void {
		const client = this.current;
		if (!client) return;
		if (client.readyState !== WebSocket.OPEN) {
			this.clearWebSocket(client);
			return;
		}
		try {
			client.ping();
		} catch {
			this.clearWebSocket(client);
		}
	}
}
