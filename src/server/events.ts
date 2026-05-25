export interface EventSource<TEvent> {
	onEvent: (handler: (event: TEvent) => void | Promise<void>) => void;
}

export function createEventEmitter<TEvent>(
	initialHandlers: Array<(event: TEvent) => void | Promise<void>> = [],
): EventSource<TEvent> & { emit: (event: TEvent) => void } {
	const handlers: Array<(event: TEvent) => void | Promise<void>> = [...initialHandlers];
	return {
		onEvent: (handler) => handlers.push(handler),
		emit: (event) => {
			for (const handler of handlers) void handler(event);
		},
	};
}
