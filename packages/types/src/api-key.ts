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

/**
 * How many trailing characters of an API key are stored alongside its hash.
 *
 * The value is NOT secret — it is returned by the key-listing endpoint so the
 * UI can tell keys apart — and it exists so a presented key can be matched to
 * its record without hashing every record in turn.
 */
export const API_KEY_LOOKUP_SUFFIX_LENGTH = 8;

/**
 * The lookup suffix for a key, as stored in `prefix_last_8`.
 *
 * Minting and verification MUST derive this the same way; a mismatch would make
 * a valid key unrecognisable. One exported function so the two cannot drift.
 */
export function apiKeyLookupSuffix(apiKey: string): string {
	return apiKey.slice(-API_KEY_LOOKUP_SUFFIX_LENGTH);
}

/**
 * Scheme marker on a stored hash, so old and new rows can coexist in one column
 * without a migration. The legacy scrypt values are `hex-salt:hex-hash` and can
 * never contain a `$`, which is what makes the two unambiguous.
 */
const API_KEY_HASH_PREFIX = "sha256$";

/** `sha256$` followed by a SHA-256 digest. */
const SHA256_STORED = /^sha256\$[0-9a-f]{64}$/;

/**
 * The old scheme, matched EXACTLY: a 16-byte hex salt, a colon, and a 64-byte
 * hex scrypt output. Both halves come from `.toString("hex")`, so lowercase and
 * these lengths are the only shape that was ever written.
 */
const SCRYPT_STORED = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

/**
 * Which scheme a stored hash is written in.
 *
 * `unrecognised` is a real answer, not a fallback: a value that is neither
 * shape cannot authenticate anything and must never be handed to a verifier.
 * Treating unknown values as legacy instead would be measurably worse — the
 * legacy parser splits on `:` and ignores trailing fields, so a corrupt or
 * hand-edited row could be both more permissive than intended and cost a
 * 35ms hash to reject.
 */
export type ApiKeyHashScheme = "sha256" | "scrypt-legacy" | "unrecognised";

export function apiKeyHashScheme(hashedKey: string): ApiKeyHashScheme {
	if (SHA256_STORED.test(hashedKey)) return "sha256";
	if (SCRYPT_STORED.test(hashedKey)) return "scrypt-legacy";
	return "unrecognised";
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

	/**
	 * The value stored in `hashed_key`: an unsalted SHA-256 of the key.
	 *
	 * Unsalted is deliberate, and it is what makes verification cheap: the
	 * stored value can be computed from a presented key, so the matching record
	 * is one indexed lookup rather than a scan that hashes every row.
	 *
	 * The security of that rests entirely on the INPUT being high-entropy —
	 * `generateApiKey` above draws 32 characters from `randomBytes(32)`, far
	 * beyond any dictionary or brute-force reach. A salt and a slow KDF defend a
	 * secret a human chose; they buy nothing here. This must not be reused for
	 * anything a user gets to pick.
	 */
	async hashApiKey(apiKey: string): Promise<string> {
		const digest = this.crypto
			.createHash("sha256")
			.update(apiKey)
			.digest("hex");
		return `${API_KEY_HASH_PREFIX}${digest}`;
	}

	async verifyApiKey(apiKey: string, hashedKey: string): Promise<boolean> {
		try {
			const scheme = apiKeyHashScheme(hashedKey);

			if (scheme === "unrecognised") {
				// Not a value this application ever wrote. Nothing can verify
				// against it, so refuse without spending a hash on it.
				return false;
			}

			if (scheme === "sha256") {
				// Both sides are `sha256$` plus 64 hex characters, so the lengths
				// always agree and timingSafeEqual cannot throw here.
				return this.crypto.timingSafeEqual(
					Buffer.from(await this.hashApiKey(apiKey), "utf8"),
					Buffer.from(hashedKey, "utf8"),
				);
			}

			// Legacy rows: salted scrypt, kept working indefinitely. Rows are
			// rewritten to the scheme above the first time their key is presented,
			// so this stays load-bearing only for keys that are never used again.
			//
			// ASYNCHRONOUS deliberately. scryptSync costs ~35ms of CPU and blocks
			// the event loop for every millisecond of it, which is what froze the
			// proxy; Bun runs the callback form on its threadpool, so the same work
			// costs the loop nothing. That matters beyond migration: the stored
			// lookup suffix is public, so anyone can force this path with a wrong
			// key, and it must not be a way to stall request serving.
			const [salt, hash] = hashedKey.split(":");

			const derived: Buffer = await new Promise((resolve, reject) => {
				this.crypto.scrypt(
					apiKey,
					salt,
					64,
					(err: Error | null, derivedKey: Buffer) =>
						err ? reject(err) : resolve(derivedKey),
				);
			});
			const candidateHash = derived.toString("hex");

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
