import type { LogEntry, LogOrigin } from "../types.js";

export type LogSink = (entry: LogEntry) => void | Promise<void>;

interface LoggerState {
	sink: LogSink;
	sequence: number;
	queue: Promise<void>;
}

const reset = "\x1b[0m";
const colors = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m", "\x1b[34m", "\x1b[31m", "\x1b[90m"];

function tagColor(tag: string): string {
	let hash = 0;
	for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
	return colors[Math.abs(hash) % colors.length]!;
}

export function formatEntry(entry: LogEntry, color = false): string {
	const tags = [entry.origin, ...entry.tags.filter((tag, index) => index !== 0 || tag !== entry.origin)];
	const prefix = tags.map((tag) => (color ? `${tagColor(tag)}[${tag}]${reset}` : `[${tag}]`)).join("");
	return `${prefix} ${entry.message}`;
}

export class Logger {
	constructor(
		private readonly state: LoggerState = {
			sink: (entry) => console.log(formatEntry(entry, true)),
			sequence: 0,
			queue: Promise.resolve(),
		},
		private readonly tags: string[] = [],
	) {}

	tag(tag: string): Logger {
		return new Logger(this.state, [...this.tags, tag]);
	}

	log(message: string): void {
		this.write("server", this.tags, message, Date.now());
	}

	logRaw(origin: LogOrigin, tags: string[], message: string, time = Date.now()): void {
		this.write(origin, tags, message, time);
	}

	async flush(): Promise<void> {
		await this.state.queue;
	}

	private write(origin: LogOrigin, tags: string[], message: string, time: number): void {
		const entry = this.createEntry(origin, tags, message, time);
		this.state.queue = this.state.queue
			.catch(() => undefined)
			.then(() => this.state.sink(entry))
			.catch((error) =>
				console.error(`[logger] sink failed: ${error instanceof Error ? error.message : String(error)}`),
			);
	}

	private createEntry(origin: LogOrigin, tags: string[], message: string, time: number): LogEntry {
		return {
			origin,
			sequence: ++this.state.sequence,
			time,
			tags,
			message,
			formatted: formatEntry({ origin, sequence: 0, time: 0, tags, message, formatted: "" }),
		};
	}
}

export function createLogger(sink?: LogSink): Logger {
	return new Logger(sink ? { sink, sequence: 0, queue: Promise.resolve() } : undefined);
}
