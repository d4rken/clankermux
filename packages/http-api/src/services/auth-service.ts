import type { DatabaseOperations } from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import type { ApiKey, CryptoUtils } from "@clankermux/types";
import {
	apiKeyHashScheme,
	apiKeyLookupSuffix,
	NodeCryptoUtils,
} from "@clankermux/types";
import { extractApiKey } from "./extract-api-key";
import { managementAuthRequirement } from "./management-auth-policy";
import { SessionAuthService } from "./session-auth-service";

const logger = new Logger("Auth");

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKeyId?: string;
	apiKeyName?: string;
	error?: string;
}

/**
 * Authentication policy: what each surface requires.
 *
 * Two independent credentials, gating two independent things:
 *
 *  - `api_key` gates UPSTREAM AI TRAFFIC (`/v1/*`, `/messages/*`, and the
 *    `/wire/*` mounts). Machine clients.
 *  - `session` gates the MANAGEMENT API (`/api/*`) behind the app-level login,
 *    and FAILS OPEN until an operator sets a password.
 *
 * `/health` and the read-only widget surface (`/public/v1/*`) are public by
 * design; so is everything the dashboard serves as static assets.
 */
export type AuthRequirement = "public" | "api_key" | "session";

function policyFor(path: string): AuthRequirement {
	if (path === "/health") return "public";
	// The agent-traffic mounts. A caller is expected to hand us the STRIPPED,
	// canonical path together with an explicit `api_key` requirement, so a
	// `/wire/…` path arriving here means someone forgot to strip it. Gate it
	// anyway: the whole namespace is upstream AI traffic, and the alternative
	// is the public catch-all at the bottom of this function.
	if (path === "/wire" || path.startsWith("/wire/")) return "api_key";
	// Read-only widget API for devices that cannot hold a credential. Public by
	// construction — it is a sibling of `/wire/*`, deliberately OUTSIDE `/api/*`
	// so the session gate never touches it.
	if (path === "/public" || path.startsWith("/public/")) return "public";
	// The management surface. The classification lives in one shared module so
	// this policy and the router's own boundary cannot disagree about which
	// `/api/*` paths are exempt (the auth endpoints, and the two Claude Code
	// telemetry paths that reach the root of the port).
	//
	// DEFENSE IN DEPTH, not the primary mechanism: `routeRootRequest` gates
	// `/api/*` explicitly before the API router ever runs, because the router
	// returns its response without consulting this service at all.
	if (path === "/api" || path.startsWith("/api/")) {
		return managementAuthRequirement(path);
	}
	if (path === "/v1" || path.startsWith("/v1/")) return "api_key";
	if (path === "/messages" || path.startsWith("/messages/")) return "api_key";
	// Everything else (dashboard HTML, static assets, client-side routes) is public.
	return "public";
}

export class AuthService {
	private crypto: CryptoUtils;
	private dbOps: DatabaseOperations;
	private sessionAuth: SessionAuthService;

	constructor(
		dbOps: DatabaseOperations,
		crypto: CryptoUtils = new NodeCryptoUtils(),
		/**
		 * The management-session checker. Constructed from `dbOps` by default so
		 * a `session` requirement can never silently degrade to "allowed" just
		 * because a caller built this service the short way.
		 */
		sessionAuth: SessionAuthService = new SessionAuthService(dbOps),
	) {
		this.dbOps = dbOps;
		this.crypto = crypto;
		this.sessionAuth = sessionAuth;
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
	 *
	 * `requirement` lets a caller that already classified the route say so
	 * outright, and it OVERRIDES `policyFor` entirely. The mounted agent
	 * namespace needs this: the router strips `/wire/<dialect>` before anything
	 * downstream runs, so what arrives here is a canonical path like
	 * `/api/event_logging/v2/batch` — which `policyFor` reads as public
	 * management surface, while the request is in fact upstream AI traffic that
	 * has to present a key. The classification is the router's to make; inferring
	 * it a second time from a path that no longer carries the mount can only get
	 * it wrong.
	 */
	async authenticateRequest(
		req: Request,
		path: string,
		_method: string,
		requirement?: AuthRequirement,
	): Promise<AuthenticationResult> {
		const effective = requirement ?? policyFor(path);
		if (effective === "public") {
			return { isAuthenticated: true };
		}

		if (effective === "session") {
			// FAIL-OPEN until a password is set, and one indexed lookup when one is.
			// No key derivation on this path, ever.
			if (await this.sessionAuth.authorizeRequest(req)) {
				return { isAuthenticated: true };
			}
			return {
				isAuthenticated: false,
				error: "Sign in to use the management API",
			};
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
