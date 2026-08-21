import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import {
	apiKeyHashScheme,
	apiKeyLookupSuffix,
	NodeCryptoUtils,
} from "@clankermux/types";
import { extractApiKey } from "./extract-api-key";

const logger = new Logger("Auth");

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

export class AuthService {
	private crypto: CryptoUtils;
	private dbOps: DatabaseOperations;

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
		// A stored hash is the unsalted SHA-256 of the key, so the record can be
		// computed rather than searched for: one indexed lookup, no key hashing,
		// and no cost that scales with how many keys exist. The query filters on
		// is_active, so deactivating or deleting a key stops it here with no
		// revocation event to plumb anywhere.
		const lookupHash = await this.crypto.hashApiKey(apiKey);
		const migrated = await this.dbOps.getApiKeyByHashedKey(lookupHash);
		if (migrated) return this.accept(migrated);

		// Miss. Either the key is wrong, or its row still holds a salted scrypt
		// hash — which cannot be computed from the key, only checked against it.
		const suffix = apiKeyLookupSuffix(apiKey);
		for (const keyRecord of await this.dbOps.getActiveApiKeys()) {
			// The stored suffix is not a secret (the key-listing endpoint returns
			// it so the UI can tell keys apart), so narrowing by it discloses
			// nothing — and the full key still has to survive the check below.
			if (keyRecord.prefixLast8 !== suffix) continue;
			// Only rows actually written in the old scheme can be checked here. An
			// already-migrated row could only have matched the lookup above, and a
			// row in neither scheme cannot authenticate anything; hashing either
			// would cost ~35ms and could not change the answer.
			if (apiKeyHashScheme(keyRecord.hashedKey) !== "scrypt-legacy") continue;
			if (!(await this.crypto.verifyApiKey(apiKey, keyRecord.hashedKey))) {
				continue;
			}

			// `void`, not `await`: see migrateStoredHash. Awaiting this can park an
			// already-authenticated request for the adapter's ten-minute busy
			// retry, and the request's outcome does not depend on the write.
			void this.migrateStoredHash(keyRecord, lookupHash);
			return this.accept(keyRecord);
		}

		return {
			isAuthenticated: false,
			error: "Invalid API key",
		};
	}

	/** Key ids whose migration write has been started and has not finished. */
	private readonly migrationsInFlight = new Set<string>();

	/**
	 * Rewrite a verified legacy row to the SHA-256 scheme.
	 *
	 * Verification is the only moment the plaintext key is in hand, so it is the
	 * only moment this can be done — which is why every key migrates on first use
	 * and none has to be re-issued.
	 *
	 * NOT awaited by the caller, and that is load-bearing. The database adapter
	 * retries SQLITE_BUSY for up to ten minutes, so awaiting this would let write
	 * contention hold an already-authenticated request open for that long. The
	 * request does not depend on the outcome: possession was proved against a
	 * hash that was active when it was read. Usage counting is unawaited for the
	 * same reason.
	 *
	 * Single-flight per key, because not awaiting means a busy row could
	 * otherwise accumulate one ten-minute retry loop per request. At most one
	 * migration is ever in flight for a given key, so the ceiling is the number
	 * of keys. Every failure path is swallowed here, so the unawaited promise can
	 * never surface as an unhandled rejection.
	 */
	private async migrateStoredHash(
		keyRecord: ApiKey,
		newHashedKey: string,
	): Promise<void> {
		if (this.migrationsInFlight.has(keyRecord.id)) return;
		this.migrationsInFlight.add(keyRecord.id);
		try {
			// Compare-and-swap on the hash we actually verified: a regenerate that
			// landed in the window between the read and this write must not be
			// clobbered with a hash of the secret it just replaced.
			const swapped = await this.dbOps.rotateApiKeySecret(
				keyRecord.id,
				keyRecord.hashedKey,
				newHashedKey,
				keyRecord.prefixLast8,
			);
			if (!swapped) {
				logger.debug(
					`API key ${keyRecord.id} was modified while migrating its stored hash; leaving it as-is`,
				);
			}
		} catch (error) {
			logger.warn(
				`Could not migrate the stored hash for API key ${keyRecord.id}; it will keep using the slow verification path: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		} finally {
			this.migrationsInFlight.delete(keyRecord.id);
		}
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
