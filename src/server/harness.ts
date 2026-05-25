import { AgentHarness, InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type Api,
	type AssistantMessage,
	getModel,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";
import { createEventEmitter, type EventSource } from "./events.js";
import type { RobotClient } from "./robot-client.js";
import { createRobotTools, pruneImagesForContext } from "./tools/index.js";
import type { MemoryStore } from "./tools/memory.js";

function selectModel(): Model<Api> {
	const provider = process.env.PI_PROVIDER ?? "anthropic";
	const modelId = process.env.PI_MODEL ?? "claude-haiku-4-5";
	if (!getProviders().includes(provider as KnownProvider)) throw new Error(`Unknown PI_PROVIDER: ${provider}`);
	const models = getModels(provider as KnownProvider);
	if (!models.some((model) => model.id === modelId)) throw new Error(`Unknown PI_MODEL for ${provider}: ${modelId}`);
	return getModel(provider as KnownProvider, modelId as never) as Model<Api>;
}

function formatMemories(memories: string[]): string {
	if (memories.length === 0) return "No stored memories yet.";
	return memories.map((memory, index) => `${index}: ${memory}`).join("\n");
}

async function buildSystemPrompt(memoryStore: MemoryStore): Promise<string> {
	return `Du bist das Gehirn eines kleinen Roboters mit Smartphone. Antworte immer auf Deutsch. Sei verspielt, freundlich und sicher. Verwende keine Emojis. Nutze Bewegungswerkzeuge nur für kurze Dauer. Die Bewegungswerkzeuge stoppen automatisch nach ihrer Dauer. Die Hardware kann nur vorwärts fahren und sich gegen den Uhrzeigersinn drehen; rückwärts und rechts gibt es nicht. Für ungefähre Drehwinkel nutze turn_left_degrees. Wenn du aktuelle Fakten oder Internet-Informationen brauchst, nutze web_search. Wenn du Details aus einem gefundenen Treffer brauchst, nutze fetch_page_content mit der URL.

Persistente Erinnerungen:
${formatMemories(await memoryStore.list())}

Memory-Tool-Aufrufschema:
- Alle Erinnerungen lesen: memory({"action":"read"})
- Neue Erinnerung speichern: memory({"action":"append","text":"Pipi ist der Name des Roboters"})
- Erinnerung löschen: memory({"action":"remove","index":0})`;
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((entry): entry is TextContent => entry.type === "text")
		.map((entry) => entry.text)
		.join("")
		.trim();
}

export type RobotHarnessEvent =
	| { type: "assistant_start" }
	| { type: "tool_start"; name: string; args: unknown }
	| { type: "assistant_end"; text: string }
	| { type: "context_pruned"; removedImages: number; keptImages: number }
	| { type: "session_reset"; reason: string };

export interface RobotHarness extends EventSource<RobotHarnessEvent> {
	current: () => AgentHarness;
	reset: (reason: string) => Promise<void>;
}

export async function createRobotHarness(deps: {
	env: NodeExecutionEnv;
	memoryStore: MemoryStore;
	maxContextImages: number;
	robot: RobotClient;
	onEvent?: (event: RobotHarnessEvent) => void | Promise<void>;
}): Promise<RobotHarness> {
	const events = createEventEmitter<RobotHarnessEvent>(deps.onEvent ? [deps.onEvent] : []);
	const sessionRepo = new InMemorySessionRepo();
	const tools = createRobotTools(deps.robot, deps.memoryStore);
	let harness = await buildHarness();

	async function buildHarness(): Promise<AgentHarness> {
		const session = await sessionRepo.create({ id: `robot-demo-${Date.now()}` });
		const newHarness = new AgentHarness({
			env: deps.env,
			session,
			model: selectModel(),
			getApiKeyAndHeaders: async (model) => {
				const envName = `${model.provider.toUpperCase()}_API_KEY`.replaceAll("-", "_");
				const apiKey = process.env[envName] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
				return apiKey ? { apiKey } : undefined;
			},
			tools,
			systemPrompt: async () => buildSystemPrompt(deps.memoryStore),
		});
		newHarness.on("context", (event) => {
			const context = pruneImagesForContext(event.messages, deps.maxContextImages);
			if (context.removedImages > 0) {
				events.emit({
					type: "context_pruned",
					removedImages: context.removedImages,
					keptImages: deps.maxContextImages,
				});
			}
			return { messages: context.messages };
		});
		newHarness.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "assistant")
				events.emit({ type: "assistant_start" });
			if (event.type === "tool_execution_start") {
				events.emit({ type: "tool_start", name: event.toolName, args: event.args });
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				events.emit({ type: "assistant_end", text: extractAssistantText(event.message) });
			}
		});
		return newHarness;
	}

	return {
		onEvent: events.onEvent,
		current: () => harness,
		reset: async (reason) => {
			harness = await buildHarness();
			events.emit({ type: "session_reset", reason });
		},
	};
}
