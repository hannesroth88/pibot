import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export interface HomeAssistantConfig {
	baseUrl: string;
	token: string;
	allowedDomains: string[];
}

interface HomeAssistantState {
	entity_id: string;
	state: string;
	attributes?: Record<string, unknown>;
}

const listParameters = Type.Object({
	domain: Type.Optional(
		Type.String({
			description: "Optional domain filter, for example light, switch, media_player or cover.",
		}),
	),
	search: Type.Optional(
		Type.String({
			description: "Optional case-insensitive substring matched against the entity id and friendly name.",
		}),
	),
});

const getStateParameters = Type.Object({
	entity_id: Type.String({ description: "Full entity id, for example light.kinderzimmer." }),
});

const callServiceParameters = Type.Object({
	domain: Type.String({ description: "Service domain, for example light, switch, media_player or cover." }),
	service: Type.String({ description: "Service name, for example turn_on, turn_off or toggle." }),
	entity_id: Type.Optional(
		Type.String({ description: "Target entity id. Omit only for services that do not target an entity." }),
	),
	data: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				'Optional extra service data, for example { "brightness_pct": 60 } for lights. Leave empty for a simple on or off.',
		}),
	),
});

function domainOf(entityId: string): string {
	return entityId.split(".", 1)[0] ?? "";
}

function friendlyName(state: HomeAssistantState): string {
	const name = state.attributes?.friendly_name;
	return typeof name === "string" && name.length > 0 ? name : state.entity_id;
}

export async function haRequest(
	config: HomeAssistantConfig,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<unknown> {
	const url = `${config.baseUrl.replace(/\/$/, "")}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: init?.method ?? "GET",
			headers: {
				authorization: `Bearer ${config.token}`,
				"content-type": "application/json",
			},
			body: init?.body === undefined ? undefined : JSON.stringify(init.body),
			signal: AbortSignal.timeout(30000),
		});
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`Home Assistant network error: ${cause}`);
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Home Assistant request failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
	}
	return response.json();
}

function assertAllowedDomain(config: HomeAssistantConfig, domain: string): void {
	if (!config.allowedDomains.includes(domain)) {
		throw new Error(`Domain ${domain} is not allowed. Allowed domains: ${config.allowedDomains.join(", ")}.`);
	}
}

export function createHomeAssistantTools(config: HomeAssistantConfig | undefined): AgentTool[] {
	if (!config) return [];

	const listEntities: AgentTool<typeof listParameters, { count: number }> = {
		name: "homeassistant_list_entities",
		label: "Home Assistant Entitäten",
		description:
			"Liste Home-Assistant-Entitäten und ihren aktuellen Zustand auf, um steuerbare Geräte wie Lampen zu finden. Optional nach Domain oder Suchbegriff filtern.",
		parameters: listParameters,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const states = (await haRequest(config, "/api/states")) as HomeAssistantState[];
			const search = params.search?.toLowerCase();
			const filtered = states.filter((state) => {
				const domain = domainOf(state.entity_id);
				if (!config.allowedDomains.includes(domain)) return false;
				if (params.domain && domain !== params.domain) return false;
				if (search) {
					const haystack = `${state.entity_id} ${friendlyName(state)}`.toLowerCase();
					if (!haystack.includes(search)) return false;
				}
				return true;
			});
			const text =
				filtered.length === 0
					? "Keine passenden Entitäten gefunden."
					: filtered
							.map(
								(state) =>
									`${state.entity_id} [${domainOf(state.entity_id)}] ${friendlyName(state)} = ${state.state}`,
							)
							.join("\n");
			return { content: [{ type: "text", text }], details: { count: filtered.length } };
		},
	};

	const getState: AgentTool<typeof getStateParameters, { entity_id: string }> = {
		name: "homeassistant_get_state",
		label: "Home Assistant Zustand",
		description: "Lies den Zustand und die Attribute einer einzelnen Home-Assistant-Entität.",
		parameters: getStateParameters,
		executionMode: "sequential",
		execute: async (_id, params) => {
			assertAllowedDomain(config, domainOf(params.entity_id));
			const state = (await haRequest(
				config,
				`/api/states/${encodeURIComponent(params.entity_id)}`,
			)) as HomeAssistantState;
			const attributes = state.attributes ?? {};
			const attributeText = Object.entries(attributes)
				.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
				.join("\n");
			const text = `${friendlyName(state)} (${state.entity_id}) = ${state.state}${
				attributeText ? `\n${attributeText}` : ""
			}`;
			return { content: [{ type: "text", text }], details: { entity_id: state.entity_id } };
		},
	};

	const callService: AgentTool<typeof callServiceParameters, { domain: string; service: string }> = {
		name: "homeassistant_call_service",
		label: "Home Assistant Aktion",
		description:
			"Rufe einen Home-Assistant-Service auf, um Geräte zu steuern, zum Beispiel light.turn_on oder switch.turn_off. Nutze entity_id für das Zielgerät.",
		parameters: callServiceParameters,
		executionMode: "sequential",
		execute: async (_id, params) => {
			assertAllowedDomain(config, params.domain);
			if (params.entity_id) assertAllowedDomain(config, domainOf(params.entity_id));
			const body: Record<string, unknown> = { ...(params.data ?? {}) };
			if (params.entity_id) body.entity_id = params.entity_id;
			const result = (await haRequest(config, `/api/services/${params.domain}/${params.service}`, {
				method: "POST",
				body,
			})) as HomeAssistantState[];
			const changed =
				Array.isArray(result) && result.length > 0
					? result.map((state) => `${state.entity_id} = ${state.state}`).join("\n")
					: "Aktion ausgeführt.";
			return {
				content: [{ type: "text", text: `${params.domain}.${params.service} ausgeführt.\n${changed}` }],
				details: { domain: params.domain, service: params.service },
			};
		},
	};

	return [listEntities, getState, callService];
}
