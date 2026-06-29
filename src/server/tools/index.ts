import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RobotClient } from "../robot-client.js";
import { createHomeAssistantTools, type HomeAssistantConfig } from "./homeassistant.js";
import type { MemoryStore } from "./memory.js";
import { createMemoryTool } from "./memory.js";
import { createMotorTools } from "./motor.js";
import { createPhotoTool } from "./photo.js";
import { sleepTool } from "./sleep.js";
import { createSpotifyTools } from "./spotify.js";
import { pageContentTool, webSearchTool } from "./websearch.js";

export { pruneImagesForContext } from "./context.js";

export function createRobotTools(
	robot: RobotClient,
	memoryStore: MemoryStore,
	esp32Url?: string,
	homeAssistant?: HomeAssistantConfig,
	spotifyHaRooms?: Record<string, string>,
	maConfigEntryId?: string,
): AgentTool[] {
	return [
		...createMotorTools(robot, esp32Url),
		createPhotoTool(robot),
		...createSpotifyTools(robot, spotifyHaRooms, maConfigEntryId),
		...createHomeAssistantTools(homeAssistant),
		sleepTool,
		webSearchTool,
		pageContentTool,
		createMemoryTool(memoryStore),
	];
}
