// Crypto interface for dependency injection

// Database row type that matches actual database schema
export interface ApiKeyRow {
	id: string;
	name: string;
	hashed_key: string;
	prefix_last_8: string;
	created_at: number;
	last_used: number | null;
	usage_count: number;
	is_active: boolean | number;
	// Optional routing constraint: pin the key to one backend account
	// (pinned_account_id, takes precedence) or to a class of providers
	// (pinned_providers, a JSON array string). NULL = no constraint.
	pinned_account_id: string | null;
	pinned_providers: string | null;
}

// Domain model - used throughout the application
export interface ApiKey {
	id: string;
	name: string;
	hashedKey: string;
	prefixLast8: string;
	createdAt: number;
	lastUsed: number | null;
	usageCount: number;
	isActive: boolean;
	// Parsed routing constraint (see ApiKeyRow). pinnedProviders is the parsed
	// allow-list of provider names, or null when unset / unparseable.
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
}

// API response type - what clients receive (excluding sensitive data)
export interface ApiKeyResponse {
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
	pinnedAccountId: string | null;
	pinnedProviders: string[] | null;
}

// API key generation result
export interface ApiKeyGenerationResult {
	id: string;
	name: string;
	apiKey: string; // Full API key (shown only once)
	prefixLast8: string;
	createdAt: string;
}

// Input for creating API keys
export interface CreateApiKeyInput {
	name: string;
}

// Validation result
export interface ApiKeyValidationResult {
	isValid: boolean;
	apiKey?: ApiKey;
	error?: string;
}

// Crypto interface for dependency injection
export interface CryptoUtils {
	generateApiKey(): Promise<string>;
	hashApiKey(apiKey: string): Promise<string>;
	verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean>;
}

// Default implementation using Node.js crypto
export class NodeCryptoUtils implements CryptoUtils {
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic require for Node.js crypto module compatibility
	private crypto: any;

	constructor() {
		// Import crypto dynamically to avoid issues with bundling
		this.crypto = require("node:crypto");
	}

	async generateApiKey(): Promise<string> {
		const bytes = this.crypto.randomBytes(32);
		const key = bytes
			.toString("base64url")
			.replace(/[^a-zA-Z0-9]/g, "")
			.substring(0, 32);
		return `btr-${key}`;
	}

	async hashApiKey(apiKey: string): Promise<string> {
		const salt = this.crypto.randomBytes(16).toString("hex");
		const hash = this.crypto.scryptSync(apiKey, salt, 64).toString("hex");
		return `${salt}:${hash}`;
	}

	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		try {
			const [salt, hash] = hashedKey.split(":");
			if (!salt || !hash) {
				return false;
			}

			const candidateHash = this.crypto
				.scryptSync(apiKey, salt, 64)
				.toString("hex");

			// Length validation before timing-safe comparison
			if (candidateHash.length !== hash.length) {
				return false;
			}

			// Constant-time comparison to prevent timing attacks
			const candidateBuffer = Buffer.from(candidateHash, "utf8");
			const storedBuffer = Buffer.from(hash, "utf8");

			return this.crypto.timingSafeEqual(candidateBuffer, storedBuffer);
		} catch (error) {
			// Log error for debugging but don't expose details to caller
			console.error(
				"API key verification error:",
				error instanceof Error ? error.message : "Unknown error",
			);
			return false;
		}
	}
}

// Defensively parse the stored pinned_providers JSON array string. Returns the
// allow-list only when the value is a non-empty array of strings; null/empty,
// invalid JSON, or any non-array/non-string-element shape all collapse to null
// (never throws). Exported so the routing layer can distinguish "no pin" from
// "pin stored but unparseable" and fail closed on the latter.
export function parsePinnedProviders(raw: string | null): string[] | null {
	if (raw == null || raw === "") {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every((p) => typeof p === "string")
		) {
			return parsed as string[];
		}
		return null;
	} catch {
		return null;
	}
}

// Converter functions
export function toApiKey(row: ApiKeyRow): ApiKey {
	return {
		id: row.id,
		name: row.name,
		hashedKey: row.hashed_key,
		prefixLast8: row.prefix_last_8,
		createdAt: Number(row.created_at),
		lastUsed: row.last_used != null ? Number(row.last_used) : null,
		usageCount: Number(row.usage_count) || 0,
		isActive: !!row.is_active,
		pinnedAccountId: row.pinned_account_id ?? null,
		pinnedProviders: parsePinnedProviders(row.pinned_providers),
	};
}

export function toApiKeyResponse(apiKey: ApiKey): ApiKeyResponse {
	return {
		id: apiKey.id,
		name: apiKey.name,
		prefixLast8: apiKey.prefixLast8,
		createdAt: new Date(apiKey.createdAt).toISOString(),
		lastUsed: apiKey.lastUsed ? new Date(apiKey.lastUsed).toISOString() : null,
		usageCount: apiKey.usageCount,
		isActive: apiKey.isActive,
		pinnedAccountId: apiKey.pinnedAccountId,
		pinnedProviders: apiKey.pinnedProviders,
	};
}
