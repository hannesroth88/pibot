import type {
	RobotRpcMap,
	SpotifyAction,
	SpotifyDeviceInfo,
	SpotifyItemType,
	SpotifyNowPlaying,
	SpotifyRpcResponse,
	SpotifySearchResult,
} from "../../types.js";
import type { ClientLogger } from "../logger.js";
import { throwIfAborted } from "./common.js";

const clientIdKey = "spotify_client_id";
const accessTokenKey = "spotify_access_token";
const refreshTokenKey = "spotify_refresh_token";
const expiresAtKey = "spotify_expires_at";
const verifierKey = "spotify_verifier";
const stateKey = "spotify_oauth_state";
const selectedDeviceKey = "spotify_device_id";
const displayNameKey = "spotify_display_name";

const spotifyScopes = [
	"user-read-private",
	"user-read-email",
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-read-currently-playing",
	"streaming",
].join(" ");

interface SpotifyTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

interface SpotifyProfileResponse {
	display_name?: string;
	id?: string;
}

interface SpotifyDevicesResponse {
	devices?: Array<{
		id?: string | null;
		is_active?: boolean;
		name?: string;
		type?: string;
	}>;
}

interface SpotifyImage {
	url: string;
	height?: number | null;
	width?: number | null;
}

interface SpotifyNamedUri {
	name: string;
	uri: string;
	type: string;
	images?: SpotifyImage[];
	album?: { images?: SpotifyImage[] };
	artists?: Array<{ name: string }>;
	owner?: { display_name?: string; id?: string };
	publisher?: string;
	show?: { name?: string; images?: SpotifyImage[] };
	audiobook?: { name?: string; images?: SpotifyImage[] };
}

interface SpotifySearchResponse {
	tracks?: { items?: SpotifyNamedUri[] };
	albums?: { items?: SpotifyNamedUri[] };
	playlists?: { items?: SpotifyNamedUri[] };
	shows?: { items?: SpotifyNamedUri[] };
	episodes?: { items?: SpotifyNamedUri[] };
	audiobooks?: { items?: SpotifyNamedUri[] };
}

interface SpotifyPlaybackResponse {
	is_playing?: boolean;
	item?: SpotifyNamedUri | null;
}

interface SpotifySdkPayload {
	device_id?: string;
	message?: string;
}

interface SpotifyPlayer {
	connect(): Promise<boolean>;
	addListener(event: string, callback: (payload: SpotifySdkPayload) => void): void;
}

interface SpotifyPlayerConstructor {
	new (options: {
		name: string;
		getOAuthToken: (callback: (token: string) => void) => void;
		volume?: number;
	}): SpotifyPlayer;
}

declare global {
	interface Window {
		onSpotifyWebPlaybackSDKReady?: () => void;
		Spotify?: { Player: SpotifyPlayerConstructor };
	}
}

export interface SpotifyStatus {
	clientId: string;
	redirectUri: string;
	connected: boolean;
	expiresAt?: number;
	displayName?: string;
	devices: SpotifyDeviceInfo[];
	selectedDeviceId?: string;
	browserPlayerReady: boolean;
}

export interface SpotifyTool {
	handleRedirectCallback: () => Promise<boolean>;
	getStatus: () => SpotifyStatus;
	setClientId: (clientId: string) => void;
	login: () => Promise<void>;
	disconnect: () => void;
	loadDevices: () => Promise<SpotifyDeviceInfo[]>;
	selectDevice: (deviceId: string | undefined) => void;
	startBrowserPlayer: () => Promise<void>;
	handle: (
		payload: RobotRpcMap["spotify"]["request"],
		signal: AbortSignal,
	) => Promise<RobotRpcMap["spotify"]["response"]>;
}

function currentRedirectUri(): string {
	return `${window.location.origin}${window.location.pathname}`;
}

function randomString(length: number): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

async function codeChallenge(verifier: string): Promise<string> {
	const data = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function spotifySearchKey(itemType: SpotifyItemType): keyof SpotifySearchResponse {
	if (itemType === "track") return "tracks";
	if (itemType === "album") return "albums";
	if (itemType === "playlist") return "playlists";
	if (itemType === "show") return "shows";
	if (itemType === "episode") return "episodes";
	return "audiobooks";
}

function spotifyError(data: SpotifyTokenResponse): string {
	return data.error_description ?? data.error ?? "Spotify authorization failed";
}

function imageFor(item: SpotifyNamedUri): string | undefined {
	return (
		item.images?.[0]?.url ??
		item.album?.images?.[0]?.url ??
		item.show?.images?.[0]?.url ??
		item.audiobook?.images?.[0]?.url
	);
}

function subtitleFor(item: SpotifyNamedUri): string | undefined {
	if (item.artists && item.artists.length > 0) return item.artists.map((artist) => artist.name).join(", ");
	if (item.owner) return item.owner.display_name ?? item.owner.id;
	if (item.publisher) return item.publisher;
	if (item.show?.name) return item.show.name;
	if (item.audiobook?.name) return item.audiobook.name;
	return undefined;
}

function itemTypeFor(item: SpotifyNamedUri): SpotifyItemType {
	if (item.type === "album") return "album";
	if (item.type === "playlist") return "playlist";
	if (item.type === "audiobook") return "audiobook";
	if (item.type === "show") return "show";
	if (item.type === "episode") return "episode";
	return "track";
}

function nowPlayingFromItem(item: SpotifyNamedUri, isPlaying?: boolean): SpotifyNowPlaying {
	return {
		title: item.name,
		subtitle: subtitleFor(item),
		uri: item.uri,
		coverUrl: imageFor(item),
		isPlaying,
	};
}

function searchResultFromItem(item: SpotifyNamedUri): SpotifySearchResult {
	return { ...nowPlayingFromItem(item), type: itemTypeFor(item), uri: item.uri };
}

function success(action: Exclude<SpotifyAction, "search">, playback?: SpotifyNowPlaying): SpotifyRpcResponse {
	return {
		ok: true,
		action,
		title: playback?.title,
		subtitle: playback?.subtitle,
		uri: playback?.uri,
		coverUrl: playback?.coverUrl,
		isPlaying: playback?.isPlaying,
	};
}

export function createSpotifyTool(deps: {
	logger: ClientLogger;
	onPlaybackChange: (playback: SpotifyNowPlaying | undefined) => void;
	onStatusChange: () => void;
}): SpotifyTool {
	const logger = deps.logger.tag("spotify");
	let devices: SpotifyDeviceInfo[] = [];
	let browserPlayerReady = false;
	let sdkReadyPromise: Promise<void> | undefined;
	let player: SpotifyPlayer | undefined;

	function clientId(): string {
		return localStorage.getItem(clientIdKey) ?? "";
	}

	function selectedDeviceId(): string | undefined {
		return localStorage.getItem(selectedDeviceKey) ?? undefined;
	}

	function token(): { accessToken?: string; expiresAt?: number } {
		return {
			accessToken: localStorage.getItem(accessTokenKey) ?? undefined,
			expiresAt: Number(localStorage.getItem(expiresAtKey) ?? "0") || undefined,
		};
	}

	function isConnected(): boolean {
		const current = token();
		return Boolean(
			localStorage.getItem(refreshTokenKey) ||
				(current.accessToken && current.expiresAt && Date.now() < current.expiresAt),
		);
	}

	function setTokenData(data: SpotifyTokenResponse): void {
		if (!data.access_token) throw new Error(spotifyError(data));
		localStorage.setItem(accessTokenKey, data.access_token);
		if (data.refresh_token) localStorage.setItem(refreshTokenKey, data.refresh_token);
		if (data.expires_in) localStorage.setItem(expiresAtKey, String(Date.now() + data.expires_in * 1000 - 60_000));
		deps.onStatusChange();
	}

	async function refreshAccessToken(signal?: AbortSignal): Promise<string> {
		const refreshToken = localStorage.getItem(refreshTokenKey);
		if (!clientId() || !refreshToken) throw new Error("Spotify is not connected. Connect it on the setup page.");
		const response = await fetch("https://accounts.spotify.com/api/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: clientId(), grant_type: "refresh_token", refresh_token: refreshToken }),
			signal,
		});
		const data = (await response.json()) as SpotifyTokenResponse;
		if (!response.ok) throw new Error(spotifyError(data));
		setTokenData(data);
		return data.access_token ?? "";
	}

	async function ensureToken(signal?: AbortSignal): Promise<string> {
		const current = token();
		if (current.accessToken && current.expiresAt && Date.now() < current.expiresAt) return current.accessToken;
		return await refreshAccessToken(signal);
	}

	async function api<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T | undefined> {
		const accessToken = await ensureToken(signal);
		const headers = new Headers(options.headers);
		headers.set("Authorization", `Bearer ${accessToken}`);
		headers.set("Content-Type", "application/json");
		const response = await fetch(`https://api.spotify.com/v1${path}`, { ...options, headers, signal });
		if (response.status === 204) return undefined;
		const text = await response.text();
		const contentType = response.headers.get("content-type") ?? "";
		const body = text && contentType.includes("application/json") ? (JSON.parse(text) as unknown) : undefined;
		if (!response.ok) throw new Error(`Spotify API ${response.status}: ${body ? JSON.stringify(body) : text}`);
		return body as T | undefined;
	}

	async function fetchProfile(signal?: AbortSignal): Promise<void> {
		const profile = await api<SpotifyProfileResponse>("/me", {}, signal);
		const name = profile?.display_name ?? profile?.id;
		if (name) localStorage.setItem(displayNameKey, name);
		deps.onStatusChange();
	}

	async function handleRedirectCallback(): Promise<boolean> {
		const params = new URLSearchParams(window.location.search);
		const code = params.get("code");
		const state = params.get("state");
		const error = params.get("error");
		const expectedState = localStorage.getItem(stateKey);
		if (!code && !error) return false;
		if (!expectedState || state !== expectedState) return false;
		if (error) throw new Error(`Spotify authorization failed: ${error}`);
		const verifier = localStorage.getItem(verifierKey);
		if (!code || !verifier || !clientId()) throw new Error("Spotify authorization state is incomplete");
		const response = await fetch("https://accounts.spotify.com/api/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId(),
				grant_type: "authorization_code",
				code,
				redirect_uri: currentRedirectUri(),
				code_verifier: verifier,
			}),
		});
		const data = (await response.json()) as SpotifyTokenResponse;
		if (!response.ok) throw new Error(spotifyError(data));
		setTokenData(data);
		localStorage.removeItem(verifierKey);
		localStorage.removeItem(stateKey);
		window.history.replaceState({}, "", currentRedirectUri());
		await fetchProfile();
		logger.log("connected");
		return true;
	}

	function setClientId(value: string): void {
		localStorage.setItem(clientIdKey, value.trim());
		deps.onStatusChange();
	}

	async function login(): Promise<void> {
		if (!clientId()) throw new Error("Set a Spotify client ID first.");
		const verifier = randomString(96);
		const state = randomString(32);
		localStorage.setItem(verifierKey, verifier);
		localStorage.setItem(stateKey, state);
		const params = new URLSearchParams({
			client_id: clientId(),
			response_type: "code",
			redirect_uri: currentRedirectUri(),
			scope: spotifyScopes,
			code_challenge_method: "S256",
			code_challenge: await codeChallenge(verifier),
			state,
		});
		window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
	}

	function disconnect(): void {
		for (const key of [
			accessTokenKey,
			refreshTokenKey,
			expiresAtKey,
			verifierKey,
			stateKey,
			selectedDeviceKey,
			displayNameKey,
		]) {
			localStorage.removeItem(key);
		}
		devices = [];
		browserPlayerReady = false;
		deps.onPlaybackChange(undefined);
		deps.onStatusChange();
		logger.log("disconnected");
	}

	async function loadDevices(signal?: AbortSignal): Promise<SpotifyDeviceInfo[]> {
		const response = await api<SpotifyDevicesResponse>("/me/player/devices", {}, signal);
		devices = (response?.devices ?? [])
			.filter((device) => Boolean(device.id))
			.map((device) => ({
				id: device.id ?? "",
				name: device.name ?? "Spotify device",
				type: device.type ?? "unknown",
				isActive: Boolean(device.is_active),
			}));
		deps.onStatusChange();
		return devices;
	}

	function selectDevice(deviceId: string | undefined): void {
		if (deviceId) localStorage.setItem(selectedDeviceKey, deviceId);
		else localStorage.removeItem(selectedDeviceKey);
		deps.onStatusChange();
	}

	function loadSdk(): Promise<void> {
		if (window.Spotify) return Promise.resolve();
		if (sdkReadyPromise) return sdkReadyPromise;
		sdkReadyPromise = new Promise((resolve) => {
			window.onSpotifyWebPlaybackSDKReady = () => resolve();
			const script = document.createElement("script");
			script.src = "https://sdk.scdn.co/spotify-player.js";
			document.body.append(script);
		});
		return sdkReadyPromise;
	}

	async function startBrowserPlayer(): Promise<void> {
		await loadSdk();
		if (!window.Spotify) throw new Error("Spotify Web Playback SDK did not load");
		if (player && browserPlayerReady) return;
		player = new window.Spotify.Player({
			name: "Pipi",
			getOAuthToken: (callback) => {
				void ensureToken()
					.then(callback)
					.catch((error: unknown) => logger.log(`token refresh failed: ${String(error)}`));
			},
			volume: 0.45,
		});
		player.addListener("ready", (payload) => {
			if (!payload.device_id) return;
			browserPlayerReady = true;
			selectDevice(payload.device_id);
			logger.log(`browser player ready device=${payload.device_id}`);
			void api<void>("/me/player", {
				method: "PUT",
				body: JSON.stringify({ device_ids: [payload.device_id], play: false }),
			}).catch((error: unknown) => logger.log(`device transfer failed: ${String(error)}`));
			void loadDevices().catch((error: unknown) => logger.log(`device load failed: ${String(error)}`));
		});
		player.addListener("not_ready", (payload) =>
			logger.log(`browser player not ready device=${payload.device_id ?? "unknown"}`),
		);
		player.addListener("initialization_error", (payload) =>
			logger.log(`SDK initialization error: ${payload.message ?? "unknown"}`),
		);
		player.addListener("authentication_error", (payload) =>
			logger.log(`SDK authentication error: ${payload.message ?? "unknown"}`),
		);
		player.addListener("account_error", (payload) =>
			logger.log(`SDK account error: ${payload.message ?? "unknown"}`),
		);
		const connected = await player.connect();
		if (!connected) throw new Error("Spotify browser player connection failed");
		deps.onStatusChange();
	}

	async function current(signal?: AbortSignal): Promise<SpotifyNowPlaying | undefined> {
		const response = await api<SpotifyPlaybackResponse>("/me/player/currently-playing?market=from_token", {}, signal);
		if (!response?.item) {
			deps.onPlaybackChange(undefined);
			return undefined;
		}
		const playback = nowPlayingFromItem(response.item, Boolean(response.is_playing));
		deps.onPlaybackChange(playback);
		return playback;
	}

	async function search(
		query: string,
		itemType: SpotifyItemType,
		limit: number,
		signal?: AbortSignal,
	): Promise<SpotifySearchResult[]> {
		const safeLimit = String(Math.max(1, Math.min(10, Math.floor(limit))));
		const params = new URLSearchParams({ q: query, type: itemType, limit: safeLimit, market: "from_token" });
		const response = await api<SpotifySearchResponse>(`/search?${params.toString()}`, {}, signal);
		return (response?.[spotifySearchKey(itemType)]?.items ?? []).map(searchResultFromItem);
	}

	async function playUri(uri: string, signal?: AbortSignal): Promise<SpotifyNowPlaying> {
		const deviceId = selectedDeviceId();
		const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
		const body =
			uri.startsWith("spotify:track:") || uri.startsWith("spotify:episode:")
				? { uris: [uri] }
				: { context_uri: uri };
		await api<void>(`/me/player/play${suffix}`, { method: "PUT", body: JSON.stringify(body) }, signal);
		const playback = (await current(signal)) ?? { uri, isPlaying: true };
		deps.onPlaybackChange(playback);
		logger.log(`play ${uri}`);
		return playback;
	}

	async function handle(
		payload: RobotRpcMap["spotify"]["request"],
		signal: AbortSignal,
	): Promise<RobotRpcMap["spotify"]["response"]> {
		try {
			throwIfAborted(signal);
			if (payload.action === "search") {
				const query = payload.query.trim();
				if (!query) throw new Error("Spotify query is required for search");
				return {
					ok: true,
					action: "search",
					results: await search(query, payload.itemType ?? "track", payload.limit ?? 5, signal),
				};
			}
			if (payload.action === "play") {
				const uri = payload.uri.trim();
				if (!uri.startsWith("spotify:"))
					throw new Error("Spotify play requires a spotify: URI from spotify_search");
				return success("play", await playUri(uri, signal));
			}
			if (payload.action === "pause") {
				const deviceId = selectedDeviceId();
				const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
				await api<void>(`/me/player/pause${suffix}`, { method: "PUT" }, signal);
				const playback = await current(signal);
				return success("pause", playback);
			}
			if (payload.action === "resume") {
				const deviceId = selectedDeviceId();
				const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
				await api<void>(`/me/player/play${suffix}`, { method: "PUT", body: "{}" }, signal);
				const playback = await current(signal);
				return success("resume", playback);
			}
			if (payload.action === "next") {
				const deviceId = selectedDeviceId();
				const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
				await api<void>(`/me/player/next${suffix}`, { method: "POST" }, signal);
				const playback = await current(signal);
				return success("next", playback);
			}
			return success("current", await current(signal));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.log(`request failed: ${message}`);
			return { ok: false, error: message };
		}
	}

	return {
		handleRedirectCallback,
		getStatus: () => ({
			clientId: clientId(),
			redirectUri: currentRedirectUri(),
			connected: isConnected(),
			expiresAt: token().expiresAt,
			displayName: localStorage.getItem(displayNameKey) ?? undefined,
			devices,
			selectedDeviceId: selectedDeviceId(),
			browserPlayerReady,
		}),
		setClientId,
		login,
		disconnect,
		loadDevices,
		selectDevice,
		startBrowserPlayer,
		handle,
	};
}
