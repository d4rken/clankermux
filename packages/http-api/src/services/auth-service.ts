import { createHash } from "node:crypto";
import type { DatabaseOperations } from "@clankermux/database";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import { apiKeyLookupSuffix, NodeCryptoUtils } from "@clankermux/types";
import { extractApiKey } from "./extract-api-key";

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKeyId?: string;
	apiKeyName?: string;
	error?: string;
}

/**
 * Authentication policy: which surfaces require an API key.
 *
 * The model is intentionally narrow. API keys gate UPSTREAM AI TRAFFIC only
 * (/v1/* and /messages/*). The management surface (/api/*, /health) is
 * unauthenticated — trust boundary is "can you reach the port." Operators are
 * expected to bind ClankerMux to a loopback address or put it behind a
 * reverse proxy that enforces authentication.
 */
type AuthRequirement = "public" | "api_key";

function policyFor(path: string): AuthRequirement {
	if (path === "/health") return "public";
	if (path === "/api" || path.startsWith("/api/")) return "public";
	if (path === "/v1" || path.startsWith("/v1/")) return "api_key";
	if (path === "/messages" || path.startsWith("/messages/")) return "api_key";
	// Everything else (dashboard HTML, static assets, client-side routes) is public.
	return "public";
}

/**
 * How many verified keys are remembered. Only a successful verification creates
 * an entry, so nobody without a valid key can grow this; the cap is there so a
 * long-lived process with churning keys cannot accumulate forever.
 */
const MAX_REMEMBERED_KEYS = 512;

/** What a past verification proved, and what must still hold for it to count. */
interface RememberedKey {
	id: string;
	/** The stored hash the presented key was checked against. */
	hashedKey: string;
}

/**
 * Index for the verified-key cache. Not a security boundary — the entry it
 * finds is re-checked against the live active set before it authenticates
 * anything.
 */
function digestApiKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex");
}

export class AuthService {
	private crypto: CryptoUtils;
	private dbOps: DatabaseOperations;

	/**
	 * Keys already verified this process, by SHA-256 of the presented key.
	 *
	 * Verification runs `scryptSync`, which is intentionally expensive — a
	 * password KDF, ~35ms per call on the deployment host — and it ran on every
	 * single proxied request. The stall profiler attributed 100% of a run of
	 * 250-950ms event-loop freezes to that one frame.
	 *
	 * Digest rather than the key itself so the plaintext secret is not held in a
	 * long-lived structure. SHA-256 is sound as the index because the entry only
	 * survives the re-check in `validateApiKey`.
	 */
	private readonly rememberedKeys = new Map<string, RememberedKey>();

	constructor(
		dbOps: DatabaseOperations,
		crypto: CryptoUtils = new NodeCryptoUtils(),
	) {
		this.dbOps = dbOps;
		this.crypto = crypto;
	}

	/**
	 * Check if API authentication is enabled (has at least one active API key)
	 */
	async isAuthenticationEnabled(): Promise<boolean> {
		return (await this.dbOps.countActiveApiKeys()) > 0;
	}

	/**
	 * Verify a presented API key against the active set. Internal helper for
	 * `authenticateRequest`; callers are expected to have already confirmed
	 * the request needs an api-key check and that auth is enabled.
	 */
	private async validateApiKey(apiKey: string): Promise<AuthenticationResult> {
		// Always read the current active set. It is what decides the outcome, and
		// it is also what expires a remembered verification: a key that has been
		// deactivated, deleted or rotated is either absent here or carries a
		// different hash, so no revocation event needs to be plumbed anywhere and
		// no invalidation path can be forgotten.
		const activeApiKeys = await this.dbOps.getActiveApiKeys();

		const digest = digestApiKey(apiKey);
		const remembered = this.rememberedKeys.get(digest);
		if (remembered) {
			const current = activeApiKeys.find(
				(k) => k.id === remembered.id && k.hashedKey === remembered.hashedKey,
			);
			// A hit means: this exact key was once verified against this exact
			// stored hash, and that hash is still active. Nothing weaker.
			if (current) return this.accept(current);
			this.rememberedKeys.delete(digest);
		}

		// Hash only the record this key could possibly be. The stored suffix is
		// not a secret — the key-listing endpoint returns it so the UI can tell
		// keys apart — so narrowing by it discloses nothing, and the full key
		// still has to survive the hash comparison below.
		const suffix = apiKeyLookupSuffix(apiKey);
		for (const keyRecord of activeApiKeys) {
			if (keyRecord.prefixLast8 !== suffix) continue;
			if (await this.crypto.verifyApiKey(apiKey, keyRecord.hashedKey)) {
				this.remember(digest, keyRecord);
				return this.accept(keyRecord);
			}
		}

		return {
			isAuthenticated: false,
			error: "Invalid API key",
		};
	}

	/** Record the usage hit and build the success result from the current row. */
	private accept(keyRecord: ApiKey): AuthenticationResult {
		this.dbOps.updateApiKeyUsage(keyRecord.id, Date.now());
		return {
			isAuthenticated: true,
			apiKeyId: keyRecord.id,
			apiKeyName: keyRecord.name,
		};
	}

	private remember(digest: string, keyRecord: ApiKey): void {
		if (this.rememberedKeys.size >= MAX_REMEMBERED_KEYS) {
			// Map iterates in insertion order, so this drops the oldest entry.
			const oldest = this.rememberedKeys.keys().next();
			if (!oldest.done) this.rememberedKeys.delete(oldest.value);
		}
		this.rememberedKeys.set(digest, {
			id: keyRecord.id,
			hashedKey: keyRecord.hashedKey,
		});
	}

	extractApiKey(req: Request): string | null {
		return extractApiKey(req);
	}

	/**
	 * Authenticate a request against the auth policy.
	 *
	 * Public paths return authenticated without checking for a key. API-key
	 * paths require a valid key when at least one is configured; when none are
	 * configured, authentication is effectively disabled.
	 */
	async authenticateRequest(
		req: Request,
		path: string,
		_method: string,
	): Promise<AuthenticationResult> {
		if (policyFor(path) === "public") {
			return { isAuthenticated: true };
		}

		// API-key-gated path. If no keys are configured at all, let everything
		// through (matches single-user / first-run behavior).
		if (!(await this.isAuthenticationEnabled())) {
			return { isAuthenticated: true };
		}

		const apiKey = this.extractApiKey(req);
		if (!apiKey) {
			return {
				isAuthenticated: false,
				error:
					"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>",
			};
		}

		return await this.validateApiKey(apiKey);
	}
}
