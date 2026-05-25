export type MotorCommand = "forward" | "turn_left" | "turn_left_degrees" | "stop";

export type LogOrigin = "server" | "client";

export interface LogEntry {
	origin: LogOrigin;
	sequence: number;
	time: number;
	tags: string[];
	message: string;
	formatted: string;
}

export interface ClientLogMsg {
	type: "client_log";
	tags: string[];
	message: string;
	time: number;
}

export type RobotState =
	| { phase: "inactive" }
	| { phase: "listening" }
	| { phase: "hearing" }
	| { phase: "thinking"; heardText?: string; assistantText: string }
	| { phase: "tool"; name: string; args: unknown; assistantText: string }
	| { phase: "speaking"; assistantText: string }
	| { phase: "error"; message: string };

export interface RobotRpcMap {
	take_photo: {
		request: Record<string, never>;
		response: { dataUrl: string };
	};
	motor: {
		request: { command: MotorCommand; durationMs: number; degrees?: number };
		response: { ok: true } | { ok: false; error: string };
	};
	speak: {
		request: { url: string; text: string };
		response: { ok: true } | { ok: false; error: string };
	};
	cancel_speech: {
		request: { reason: string };
		response: { ok: true };
	};
}

export type RobotRpcType = keyof RobotRpcMap;

export type RobotWireRequest<T extends RobotRpcType = RobotRpcType> = {
	[K in RobotRpcType]: {
		type: "robot_request";
		id: string;
		request: {
			type: K;
			payload: RobotRpcMap[K]["request"];
		};
	};
}[T];

export type RobotWireResponse<T extends RobotRpcType = RobotRpcType> = {
	[K in RobotRpcType]: {
		type: "robot_response";
		id: string;
		requestType: K;
		payload?: RobotRpcMap[K]["response"];
		error?: string;
	};
}[T];

export type ServerMessage =
	| { type: "hello"; state: RobotState }
	| { type: "state"; state: RobotState }
	| { type: "log"; entry: LogEntry }
	| RobotWireRequest;

export type ClientMessage = ClientLogMsg | { type: "abort" } | { type: "reset_session" } | RobotWireResponse;
