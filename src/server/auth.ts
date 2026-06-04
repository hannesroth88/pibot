import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const sessionCookieName = "pibot_session";
const persistentCookieExpires = "Fri, 31 Dec 9999 23:59:59 GMT";
const usernamePattern = /^[a-z0-9_-]{1,32}$/;
const passwordHashPrefix = "scrypt";
const scryptKeyLength = 32;

export interface PublicUser {
	name: string;
	createdAt: string;
	updatedAt?: string;
}

interface UserRecord extends PublicUser {
	passwordHash: string;
}

interface UsersFile {
	users: UserRecord[];
}

export interface AuthenticatedUser {
	name: string;
	memoryFile: string;
}

interface SessionRecord {
	token: string;
	name: string;
	createdAt: string;
}

interface SessionsFile {
	sessions: SessionRecord[];
}

export interface UserAuthServiceOptions {
	usersFile: string;
	sessionsFile: string;
	userMemoryDir: string;
	adminUser: string;
	adminPassword: string;
	secureCookies: boolean;
}

function normalizeUsername(name: string): string {
	return name.trim().toLowerCase();
}

function assertValidUsername(name: string): void {
	if (!usernamePattern.test(name))
		throw new Error("User names must be one to thirty-two lowercase letters, digits, underscores, or dashes.");
}

function parseCookies(header: string | undefined): Map<string, string> {
	const cookies = new Map<string, string>();
	if (!header) return cookies;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 0) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (!name) continue;
		try {
			cookies.set(name, decodeURIComponent(value));
		} catch {
			cookies.set(name, value);
		}
	}
	return cookies;
}

async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16).toString("base64url");
	const key = (await scrypt(password, salt, scryptKeyLength)) as Buffer;
	return `${passwordHashPrefix}$${salt}$${key.toString("base64url")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	const [prefix, salt, hash] = storedHash.split("$");
	if (prefix !== passwordHashPrefix || !salt || !hash) return false;
	const expected = Buffer.from(hash, "base64url");
	const actual = (await scrypt(password, salt, expected.byteLength)) as Buffer;
	return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function publicUser(record: UserRecord): PublicUser {
	return { name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

export class UserAuthService {
	private readonly options: UserAuthServiceOptions;
	private sessions: Map<string, SessionRecord> | undefined;
	private users: UserRecord[] | undefined;

	constructor(options: UserAuthServiceOptions) {
		this.options = options;
	}

	memoryFileForUser(name: string): string {
		return join(this.userMemoryDirForUser(name), "memories.json");
	}

	userMemoryDirForUser(name: string): string {
		return join(this.options.userMemoryDir, normalizeUsername(name));
	}

	async listUsers(): Promise<PublicUser[]> {
		return (await this.loadUsers()).map(publicUser);
	}

	async addUser(name: string, password: string): Promise<PublicUser> {
		const normalized = normalizeUsername(name);
		assertValidUsername(normalized);
		if (!password) throw new Error("Password must not be empty.");
		const users = await this.loadUsers();
		const now = new Date().toISOString();
		const existing = users.find((user) => user.name === normalized);
		if (existing) {
			existing.passwordHash = await hashPassword(password);
			existing.updatedAt = now;
			await this.saveUsers();
			return publicUser(existing);
		}
		const record: UserRecord = { name: normalized, passwordHash: await hashPassword(password), createdAt: now };
		users.push(record);
		users.sort((left, right) => left.name.localeCompare(right.name));
		await this.saveUsers();
		return publicUser(record);
	}

	async removeUser(name: string): Promise<boolean> {
		const normalized = normalizeUsername(name);
		const users = await this.loadUsers();
		const index = users.findIndex((user) => user.name === normalized);
		if (index < 0) return false;
		users.splice(index, 1);
		const sessions = await this.loadSessions();
		for (const [token, session] of sessions) {
			if (session.name === normalized) sessions.delete(token);
		}
		await this.saveSessions();
		await this.saveUsers();
		await rm(this.userMemoryDirForUser(normalized), { recursive: true, force: true });
		return true;
	}

	async verifyUser(name: string, password: string): Promise<AuthenticatedUser | undefined> {
		const normalized = normalizeUsername(name);
		const user = (await this.loadUsers()).find((entry) => entry.name === normalized);
		if (!user) return undefined;
		if (!(await verifyPassword(password, user.passwordHash))) return undefined;
		return { name: user.name, memoryFile: this.memoryFileForUser(user.name) };
	}

	async createSession(name: string): Promise<string> {
		const token = randomBytes(32).toString("base64url");
		const sessions = await this.loadSessions();
		sessions.set(token, { token, name: normalizeUsername(name), createdAt: new Date().toISOString() });
		await this.saveSessions();
		return token;
	}

	sessionCookie(token: string): string {
		const secure = this.options.secureCookies ? "; Secure" : "";
		return `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; Expires=${persistentCookieExpires}; HttpOnly; SameSite=Strict${secure}`;
	}

	clearSessionCookie(): string {
		const secure = this.options.secureCookies ? "; Secure" : "";
		return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`;
	}

	async logout(req: IncomingMessage): Promise<void> {
		const token = parseCookies(req.headers.cookie).get(sessionCookieName);
		if (!token) return;
		(await this.loadSessions()).delete(token);
		await this.saveSessions();
	}

	async authenticateRequest(req: IncomingMessage): Promise<AuthenticatedUser | undefined> {
		const token = parseCookies(req.headers.cookie).get(sessionCookieName);
		if (!token) return undefined;
		const sessions = await this.loadSessions();
		const session = sessions.get(token);
		if (!session) return undefined;
		const users = await this.loadUsers();
		if (!users.some((user) => user.name === session.name)) {
			sessions.delete(token);
			await this.saveSessions();
			return undefined;
		}
		return { name: session.name, memoryFile: this.memoryFileForUser(session.name) };
	}

	isAdminRequest(req: IncomingMessage): boolean {
		const authorization = req.headers.authorization;
		if (!authorization?.startsWith("Basic ")) return false;
		const decoded = Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8");
		const separator = decoded.indexOf(":");
		if (separator < 0) return false;
		const name = decoded.slice(0, separator);
		const password = decoded.slice(separator + 1);
		return name === this.options.adminUser && password === this.options.adminPassword;
	}

	private async loadUsers(): Promise<UserRecord[]> {
		if (this.users) return this.users;
		try {
			const parsed = JSON.parse(await readFile(this.options.usersFile, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as UsersFile).users)) {
				this.users = [];
				return this.users;
			}
			this.users = (parsed as UsersFile).users.filter(
				(user): user is UserRecord =>
					typeof user.name === "string" &&
					typeof user.passwordHash === "string" &&
					typeof user.createdAt === "string",
			);
			return this.users;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				this.users = [];
				return this.users;
			}
			throw error;
		}
	}

	private async loadSessions(): Promise<Map<string, SessionRecord>> {
		if (this.sessions) return this.sessions;
		try {
			const parsed = JSON.parse(await readFile(this.options.sessionsFile, "utf8")) as unknown;
			this.sessions = new Map();
			if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as SessionsFile).sessions)) {
				return this.sessions;
			}
			for (const session of (parsed as SessionsFile).sessions) {
				if (
					typeof session.token === "string" &&
					typeof session.name === "string" &&
					typeof session.createdAt === "string"
				) {
					this.sessions.set(session.token, session);
				}
			}
			return this.sessions;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				this.sessions = new Map();
				return this.sessions;
			}
			throw error;
		}
	}

	private async saveSessions(): Promise<void> {
		const sessions = this.sessions ? [...this.sessions.values()] : [];
		await mkdir(dirname(this.options.sessionsFile), { recursive: true });
		await writeFile(this.options.sessionsFile, `${JSON.stringify({ sessions }, null, "\t")}\n`);
	}

	private async saveUsers(): Promise<void> {
		await mkdir(dirname(this.options.usersFile), { recursive: true });
		await writeFile(this.options.usersFile, `${JSON.stringify({ users: this.users ?? [] }, null, "\t")}\n`);
	}
}
