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
			description:
				"Spotify item type to search. Allowed values: track for songs/music tracks; album for music albums; playlist for playlists; show for podcasts/shows; episode for podcast episodes; audiobook for audiobooks. Do not use 'podcast' because Spotify's API type is 'show' or 'episode'. Defaults to track.",
			default: "track",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"Number of results to return. Use at least 5 unless the user explicitly asks for fewer. Defaults to 5, maximum 10.",
		}),
	),
});

const spotifyPlayParameters = Type.Object({
	uri: Type.String({ description: "Exact spotify: URI returned by spotify_search or spotify_my_playlists." }),
	deviceId: Type.Optional(
		Type.String({
			description: "Spotify device ID from spotify_list_devices. Omit to use the currently active/selected device.",
		}),
	),
});

const spotifyMyPlaylistsParameters = Type.Object({
	limit: Type.Optional(
		Type.Number({
			description: "Number of playlists to return. Default 20, maximum 50.",
		}),
	),
});

const spotifyListDevicesParameters = Type.Object({});

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
	if (result.action === "search" || result.action === "my_playlists") {
		if (result.results.length === 0) return "No Spotify results.";
		return result.results
			.map((entry, index) => {
				const subtitle = entry.subtitle ? ` — ${entry.subtitle}` : "";
				return `${index}: ${entry.title ?? entry.uri}${subtitle} [${entry.type}] ${entry.uri}`;
			})
			.join("\n");
	}
	if (result.action === "list_devices") {
		if (result.devices.length === 0) return "No Spotify devices available.";
		return result.devices.map((d) => `${d.id} — ${d.name} (${d.type}${d.isActive ? ", active" : ""})`).join("\n");
	}
	const title = result.title ? ` ${result.title}` : "";
	const subtitle = result.subtitle ? ` by ${result.subtitle}` : "";
	const state = result.isPlaying === undefined ? "" : result.isPlaying ? " Playing." : " Paused.";
	return `Spotify ${result.action}.${title}${subtitle}.${state}`.trim();
}

export function createSpotifyTools(robot: RobotClient, haRooms?: Record<string, string>): AgentTool[] {
	const haRoomsEntries = Object.entries(haRooms ?? {});
	const haRoomsKnown = haRoomsEntries.length > 0;
	const haRoomsHint = haRoomsKnown
		? ` Known rooms: ${haRoomsEntries.map(([name, entity]) => `${name} = ${entity}`).join(", ")}.`
		: "";

	const search: AgentTool<typeof spotifySearchParameters, SpotifyRpcResponse> = {
		name: "spotify_search",
		label: "Spotify Search",
		description:
			"Search Spotify. itemType must be one of: track, album, playlist, show, episode, audiobook. For podcasts use show; for podcast episodes use episode; never use podcast as an itemType. Request at least 5 results unless the user explicitly asks for fewer. For playlist requests, only use itemType=playlist here as a fallback after spotify_my_playlists returned no matching results.",
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
		description:
			"Play an exact spotify: URI returned by spotify_search or spotify_my_playlists. If the user mentioned a room or device name (e.g. 'im Bad', 'in der Küche', 'im Wohnzimmer', 'on the speaker'), you MUST call spotify_list_devices first and pass the matching deviceId here. Never omit deviceId when a room or device was mentioned.",
		parameters: spotifyPlayParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const result = await robot.execute({
				type: "spotify",
				payload: { action: "play", uri: params.uri, deviceId: params.deviceId },
				timeoutMs: 15000,
				signal,
			});
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarizeResponse(result) }], details: result };
		},
	};

	const listDevices: AgentTool<typeof spotifyListDevicesParameters, SpotifyRpcResponse> = {
		name: "spotify_list_devices",
		label: "Spotify List Devices",
		description: `List all available Spotify Connect devices. REQUIRED step before spotify_play whenever the user mentions a room or device name (e.g. 'im Bad', 'in der Küche', 'on the speaker', 'im Wohnzimmer'). Only use spotify_play with a deviceId if a listed device name clearly matches the room the user said. If no listed device matches — do NOT pick an arbitrary device — use homeassistant_call_service instead: domain=media_player, service=play_media, entity_id=<matching media_player entity>, data={ media_content_id: <spotify uri>, media_content_type: 'music' }.${haRoomsKnown ? ` Skip homeassistant_list_entities — use the known mapping directly.${haRoomsHint}` : " Use homeassistant_list_entities with domain=media_player to find the right entity id."}`,
		parameters: spotifyListDevicesParameters,
		executionMode: "sequential",
		execute: async (_id, _params, signal) => {
			const result = await robot.execute({
				type: "spotify",
				payload: { action: "list_devices" },
				timeoutMs: 15000,
				signal,
			});
			if (!result.ok) throw new Error(result.error);
			return { content: [{ type: "text", text: summarizeResponse(result) }], details: result };
		},
	};

	const myPlaylists: AgentTool<typeof spotifyMyPlaylistsParameters, SpotifyRpcResponse> = {
		name: "spotify_my_playlists",
		label: "Spotify My Playlists",
		description:
			"Fetch the current user's own Spotify playlists from their library. Always call this first for any playlist request before using spotify_search. If the desired playlist is found here, play it directly. Only fall back to spotify_search with itemType=playlist if no match is found in the results.",
		parameters: spotifyMyPlaylistsParameters,
		executionMode: "sequential",
		execute: async (_id, params, signal) => {
			const result = await robot.execute({
				type: "spotify",
				payload: { action: "my_playlists", limit: params.limit },
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

	return [search, play, listDevices, myPlaylists, control];
}
