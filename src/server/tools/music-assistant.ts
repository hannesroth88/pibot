import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { type HomeAssistantConfig, haRequest } from "./homeassistant.js";

const maMediaTypes = ["track", "artist", "album", "playlist", "radio", "podcast", "audiobook"] as const;
const maEnqueueModes = ["play", "next", "end", "replace"] as const;

export function createMusicAssistantTools(
	haConfig: HomeAssistantConfig | undefined,
	haRooms: Record<string, string> | undefined,
): AgentTool[] {
	if (!haConfig) return [];
	const rooms = haRooms ?? {};
	const roomNames = Object.keys(rooms);
	if (roomNames.length === 0) return [];

	const playParameters = Type.Object({
		media_id: Type.String({
			description:
				"What to play. If you already have a Spotify URI from spotify_my_playlists or spotify_search, use it here (e.g. 'spotify:playlist:XXX'). Otherwise pass the user's words directly and Music Assistant searches internally. Do not call spotify_search just to obtain a URI.",
		}),
		media_type: StringEnum([...maMediaTypes], {
			description:
				"Media type: track, artist, album, playlist, radio, podcast (use for shows and podcast episodes), audiobook.",
		}),
		room: StringEnum([...roomNames] as unknown as readonly [string, ...string[]], {
			description: `Room to play in. Must be one of: ${roomNames.join(", ")}.`,
		}),
		enqueue: Type.Optional(
			StringEnum([...maEnqueueModes], {
				description: "Queue mode. Defaults to play (replaces the queue and starts immediately).",
				default: "play",
			}),
		),
	});

	const play: AgentTool<typeof playParameters, { room: string; entity_id: string }> = {
		name: "music_assistant_play",
		label: "Music Assistant Play",
		description:
			"Play music, a podcast, or an audiobook on a room speaker via Music Assistant. Use this whenever the user names a room. Do not use homeassistant_call_service for Music Assistant playback.",
		parameters: playParameters,
		executionMode: "sequential",
		execute: async (_id, params) => {
			const entityId = rooms[params.room];
			if (!entityId) throw new Error(`Unknown room: ${params.room}. Known rooms: ${roomNames.join(", ")}.`);
			await haRequest(haConfig, "/api/services/music_assistant/play_media", {
				method: "POST",
				body: {
					entity_id: entityId,
					media_id: params.media_id,
					media_type: params.media_type,
					enqueue: params.enqueue ?? "play",
				},
			});
			return {
				content: [{ type: "text", text: `Playing ${params.media_type} "${params.media_id}" in ${params.room}.` }],
				details: { room: params.room, entity_id: entityId },
			};
		},
	};

	return [play];
}
