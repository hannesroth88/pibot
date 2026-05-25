export type ShutdownHandler = () => void | Promise<void>;

const handlers: ShutdownHandler[] = [];
let registered = false;
let shuttingDown = false;

export function onShutdown(handler: ShutdownHandler): void {
	handlers.push(handler);
	if (registered) return;
	registered = true;
	process.once("SIGINT", () => void shutdown(130));
	process.once("SIGTERM", () => void shutdown(143));
}

async function shutdown(exitCode: number): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const handler of handlers) {
		try {
			await handler();
		} catch (error) {
			console.error(`[shutdown] handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	process.exit(exitCode);
}
