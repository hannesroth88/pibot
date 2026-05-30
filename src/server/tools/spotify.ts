import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { SpotifyControlAction, SpotifyItemType, SpotifyRpcResponse } from "../../types.js";
import type { RobotClient } from "../robot-client.js";

const spotifyItemTypes = ["track", "album", "playlist", "audiobook", "show", "episode"] as const;
const spotifyControlActions = ["pause", "resume", "next", "current"] as const;

const spotifySearchParameters = Type.Object({
	query: Type.String({ description: "Spotify search query." }),
	itemType: Type.Optional(
		StringEnum([...spotifyItemTypes], {
			description: "Spotify item type to search. Defaults to track.",
			default: "track",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Number of results to return. Defaults to 5, maximum 10." })),
});

const spotifyPlayParameters = Type.Object({
	uri: Type.String({ description: "Exact spotify: URI returned by spotify_search." }),
});

const spotifyControlParameters = Type.Object({
	action: StringEnum([...spotifyControlActions], {
		description: "Spotify control action: pause, resume, next, or current.",
	}),
});

function parseItemType(value: string | undefined): SpotifyItemType | undefined {
	if (value === undefined) return undefined;
	if (spotifyItemTypes.includes(value as SpotifyItemType)) return value as SpotifyItemType;
	throw new Error(`Unknown Spotify item type: ${value}`);
}

function parseControlAction(value: string): SpotifyControlAction {
	if (spotifyControlActions.includes(value as SpotifyControlAction)) return value as SpotifyControlAction;
	throw new Error(`Unknown Spotify control action: ${value}`);
}

function summarizeResponse(result: Exclude<SpotifyRpcResponse, { ok: false }>): string {
	if (result.action === "search") {
		if (result.results.length === 0) return "No Spotify results.";
		return result.results
			.map((entry, index) => {
				const subtitle = entry.subtitle ? ` — ${entry.subtitle}` : "";
				return `${index}: ${entry.title ?? entry.uri}${subtitle} [${entry.type}] ${entry.uri}`;
			})
			.join("\n");
	}
	const title = result.title ? ` ${result.title}` : "";
	const subtitle = result.subtitle ? ` by ${result.subtitle}` : "";
	const state = result.isPlaying === undefined ? "" : result.isPlaying ? " Playing." : " Paused.";
	return `Spotify ${result.action}.${title}${subtitle}.${state}`.trim();
}

export function createSpotifyTools(robot: RobotClient): AgentTool[] {
	const search: AgentTool<typeof spotifySearchParameters, SpotifyRpcResponse> = {
		name: "spotify_search",
		label: "Spotify Search",
		description:
			"Search Spotify for tracks, albums, playlists, podcasts, episodes, or audiobooks. Use this first when the requested item is ambiguous, then choose a returned spotify: URI for spotify_play.",
		parameters: spotifySearchParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const result = await robot.execute({
				type: "spotify",
				payload: {
					action: "search",
					query: params.query,
					itemType: parseItemType(params.itemType),
					limit: params.limit,
				},
				timeoutMs: 15000,
				signal,
			});
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarizeResponse(result) }], details: result };
		},
	};

	const play: AgentTool<typeof spotifyPlayParameters, SpotifyRpcResponse> = {
		name: "spotify_play",
		label: "Spotify Play",
		description: "Play an exact spotify: URI returned by spotify_search.",
		parameters: spotifyPlayParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const result = await robot.execute({
				type: "spotify",
				payload: { action: "play", uri: params.uri },
				timeoutMs: 15000,
				signal,
			});
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarizeResponse(result) }], details: result };
		},
	};

	const control: AgentTool<typeof spotifyControlParameters, SpotifyRpcResponse> = {
		name: "spotify_control",
		label: "Spotify Control",
		description: "Pause, resume, skip to next, or inspect current Spotify playback.",
		parameters: spotifyControlParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const result = await robot.execute({
				type: "spotify",
				payload: { action: parseControlAction(params.action) },
				timeoutMs: 15000,
				signal,
			});
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarizeResponse(result) }], details: result };
		},
	};

	return [search, play, control];
}
