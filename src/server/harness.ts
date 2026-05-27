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
import type { Logger } from "./logger.js";
import type { RobotClient } from "./robot-client.js";
import { createRobotTools, pruneImagesForContext } from "./tools/index.js";
import type { MemoryStore } from "./tools/memory.js";

const LOCAL_PROVIDER = "llama-cpp-qwen36";
const LOCAL_MODEL_ID = "Qwen3.6-35B-A3B-UD-Q5_K_M.gguf";
const LOCAL_API_KEY = "EMPTY";

const localQwenModel = {
	id: LOCAL_MODEL_ID,
	name: "Qwen3.6 35B A3B Q5 llama.cpp Local",
	api: "openai-completions",
	provider: LOCAL_PROVIDER,
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 131072,
	maxTokens: 16384,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: false,
		supportsStrictMode: false,
		maxTokensField: "max_tokens",
	},
} satisfies Model<"openai-completions">;

function selectModel(): Model<Api> {
	const provider = process.env.PI_PROVIDER ?? LOCAL_PROVIDER;
	const modelId = process.env.PI_MODEL ?? LOCAL_MODEL_ID;
	if (provider === LOCAL_PROVIDER) {
		if (modelId !== LOCAL_MODEL_ID) throw new Error(`Unknown PI_MODEL for ${provider}: ${modelId}`);
		return localQwenModel;
	}
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
	| { type: "session_reset"; reason: string };

export interface RobotHarness {
	current: () => AgentHarness;
	model: () => Model<Api>;
	rebuildSession: (reason: string) => Promise<void>;
}

export async function createRobotHarness(deps: {
	env: NodeExecutionEnv;
	logger: Logger;
	memoryStore: MemoryStore;
	maxContextImages: number;
	robot: RobotClient;
	onEvent: (event: RobotHarnessEvent) => void | Promise<void>;
}): Promise<RobotHarness> {
	const sessionRepo = new InMemorySessionRepo();
	const tools = createRobotTools(deps.robot, deps.memoryStore);
	const contextLogger = deps.logger.tag("context");
	const emit = async (event: RobotHarnessEvent): Promise<void> => {
		try {
			await deps.onEvent(event);
		} catch (error) {
			console.error(`[harness] event handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const selectedModel = selectModel();
	let harness = await buildHarness();

	async function buildHarness(): Promise<AgentHarness> {
		const session = await sessionRepo.create({ id: `robot-demo-${Date.now()}` });
		const newHarness = new AgentHarness({
			env: deps.env,
			session,
			model: selectedModel,
			getApiKeyAndHeaders: async (model) => {
				const envName = `${model.provider.toUpperCase()}_API_KEY`.replaceAll("-", "_");
				const apiKey = process.env[envName] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
				if (apiKey) return { apiKey };
				if (model.provider === LOCAL_PROVIDER) return { apiKey: LOCAL_API_KEY };
				return undefined;
			},
			tools,
			systemPrompt: async () => buildSystemPrompt(deps.memoryStore),
		});
		newHarness.on("context", async (event) => {
			const context = pruneImagesForContext(event.messages, deps.maxContextImages);
			if (context.removedImages > 0) {
				contextLogger.log(`removed ${context.removedImages} old image(s), kept ${deps.maxContextImages}`);
			}
			return { messages: context.messages };
		});
		newHarness.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "assistant")
				await emit({ type: "assistant_start" });
			if (event.type === "tool_execution_start") {
				await emit({ type: "tool_start", name: event.toolName, args: event.args });
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				await emit({ type: "assistant_end", text: extractAssistantText(event.message) });
			}
		});
		return newHarness;
	}

	return {
		current: () => harness,
		model: () => selectedModel,
		rebuildSession: async (reason) => {
			harness = await buildHarness();
			await emit({ type: "session_reset", reason });
		},
	};
}
