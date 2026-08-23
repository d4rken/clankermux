import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type {
	AuthSessionRecord,
	StoredPasswordVerifier,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";

const log = new Logger("SessionAuth");

/** Cookie the dashboard session rides in. */
export const SESSION_COOKIE_NAME = "cmx_session";

/**
 * Absolute ceiling on a session, from issue. Reached regardless of activity —
 * a cookie copied off a machine cannot outlive this no matter how busy it is.
 */
export const SESSION_ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Idle ceiling. A session unused for this long is dead even though its absolute
 * deadline is still far away. Both bounds are explicit and independent; neither
 * one alone is "the lifetime".
 */
export const SESSION_IDLE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How stale `last_seen_at` must be before a successful validation bothers to
 * rewrite it. The dashboard polls roughly eight endpoints concurrently, so an
 * unconditional touch would turn every protected GET into a SQLite write; at an
 * hour the idle ceiling above is still enforced to within an hour of accuracy,
 * which is a rounding error against seven days.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Longest password the login endpoint will hash. Checked BEFORE scrypt runs. */
export const MAX_PASSWORD_BYTES = 1024;

/** scrypt cost parameters for newly written verifiers. */
const CURRENT_SCRYPT_PARAMS = {
	v: 1 as const,
	kdf: "scrypt" as const,
	n: 16384,
	r: 8,
	p: 1,
	len: 64,
};

interface StoredScryptParams {
	v: number;
	kdf: string;
	n: number;
	r: number;
	p: number;
	len: number;
	salt: string;
}

/**
 * The password KDF, behind an interface so a test can substitute a cheap one.
 * Production always uses {@link scryptPasswordHasher}.
 */
export interface PasswordHasher {
	hash(password: string): Promise<{ verifier: string; params: string }>;
	verify(password: string, verifier: string, params: string): Promise<boolean>;
}

function scryptAsync(
	password: string,
	salt: Buffer,
	params: Omit<StoredScryptParams, "salt" | "v" | "kdf">,
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password,
			salt,
			params.len,
			{
				N: params.n,
				r: params.r,
				p: params.p,
				// scrypt's working set is 128 * N * r bytes; Node's default maxmem
				// (32 MiB) sits right at the limit for N=16384/r=8, so state it
				// explicitly rather than depending on the default not moving.
				maxmem: 256 * params.n * params.r,
			},
			(err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
		);
	});
}

/**
 * scrypt over an operator-chosen password.
 *
 * Asynchronous deliberately: Bun runs the callback form on its threadpool, so
 * the ~35ms of CPU costs the event loop nothing. `scryptSync` here would block
 * the proxy for the whole derivation on an endpoint anyone who can reach the
 * port may call.
 *
 * The parameters that produced a verifier travel WITH it, so raising the cost
 * later re-derives new logins at the new cost while old verifiers keep
 * verifying at the one they were written under.
 */
export const scryptPasswordHasher: PasswordHasher = {
	async hash(password) {
		const salt = randomBytes(16);
		const derived = await scryptAsync(password, salt, CURRENT_SCRYPT_PARAMS);
		const params: StoredScryptParams = {
			...CURRENT_SCRYPT_PARAMS,
			salt: salt.toString("hex"),
		};
		return {
			verifier: derived.toString("hex"),
			params: JSON.stringify(params),
		};
	},

	async verify(password, verifier, params) {
		let parsed: StoredScryptParams;
		try {
			parsed = JSON.parse(params) as StoredScryptParams;
		} catch {
			log.error(
				"Stored password parameters are not valid JSON; no password can verify against them",
			);
			return false;
		}
		if (parsed?.kdf !== "scrypt" || typeof parsed.salt !== "string") {
			log.error(
				`Stored password parameters name an unsupported KDF (${String(parsed?.kdf)})`,
			);
			return false;
		}
		const derived = await scryptAsync(
			password,
			Buffer.from(parsed.salt, "hex"),
			{
				n: parsed.n,
				r: parsed.r,
				p: parsed.p,
				len: parsed.len,
			},
		);
		const expected = Buffer.from(verifier, "hex");
		if (expected.length !== derived.length) return false;
		return timingSafeEqual(derived, expected);
	},
};

/** SHA-256 of a session token, hex — what `auth_sessions.token_hash` holds. */
export function hashSessionToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/**
 * Read the session cookie off a request. Returns null when the header is
 * absent or carries no `cmx_session` pair.
 *
 * Splits on `;` and takes everything after the FIRST `=` as the value, because
 * a base64url token can legitimately contain no `=` but a future encoding
 * might; splitting on every `=` would truncate it.
 */
export function readSessionCookie(req: Request): string | null {
	const header = req.headers.get("cookie");
	if (!header) return null;
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		if (trimmed.slice(0, eq) !== SESSION_COOKIE_NAME) continue;
		const value = trimmed.slice(eq + 1);
		return value.length > 0 ? value : null;
	}
	return null;
}

/** `Set-Cookie` value that installs a freshly minted session. */
export function sessionCookieHeader(token: string): string {
	const maxAgeSeconds = Math.floor(SESSION_ABSOLUTE_MAX_MS / 1000);
	return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** `Set-Cookie` value that removes the session cookie. */
export function clearedSessionCookieHeader(): string {
	return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** The persistence this service needs. `DatabaseOperations` satisfies it. */
export interface SessionAuthStore {
	getManagementPassword(): Promise<StoredPasswordVerifier | null>;
	createManagementSession(record: AuthSessionRecord): Promise<void>;
	getManagementSession(tokenHash: string): Promise<AuthSessionRecord | null>;
	touchManagementSession(
		tokenHash: string,
		now: number,
		staleBeforeMs: number,
	): Promise<number>;
	deleteManagementSession(tokenHash: string): Promise<number>;
	cleanupExpiredManagementSessions(
		now: number,
		idleCutoff: number,
	): Promise<number>;
}

/** Outcome of checking a request's session cookie. */
export interface SessionCheck {
	/** True when a password is configured. False means the deployment is fail-open. */
	configured: boolean;
	/** True when the request carried a live session cookie. */
	authenticated: boolean;
	/** The validated session's token hash; null when there is no live session. */
	tokenHash: string | null;
}

/**
 * The app-level login behind `/api/*`.
 *
 * FAIL-OPEN until a password is set: with no `auth_password` row, every
 * management request is admitted and `/api/auth/status` reports
 * `configured: false` so the dashboard can say so. This is what keeps an
 * upgrade from locking an operator out of their own box.
 *
 * Verification costs are asymmetric on purpose. Logging in pays scrypt ONCE;
 * validating a session is a single indexed SHA-256 lookup and never a KDF —
 * scrypt-per-request is exactly what produced the ~300ms API-key stalls fixed
 * in v2026.8.41.
 */
export class SessionAuthService {
	constructor(
		private readonly store: SessionAuthStore,
		private readonly hasher: PasswordHasher = scryptPasswordHasher,
		private readonly now: () => number = Date.now,
	) {}

	/** Whether a management password has been configured at all. */
	async isConfigured(): Promise<boolean> {
		return (await this.store.getManagementPassword()) !== null;
	}

	/**
	 * Check a password against the stored verifier. One scrypt call, and only
	 * when a password is actually configured — an unconfigured deployment has
	 * nothing to check against and must not burn the CPU pretending otherwise.
	 */
	async verifyPassword(password: string): Promise<boolean> {
		const stored = await this.store.getManagementPassword();
		if (!stored) return false;
		return this.hasher.verify(password, stored.verifier, stored.params);
	}

	/**
	 * Mint a session. The token is 32 random bytes; only its SHA-256 is stored,
	 * so a database read cannot reconstruct a usable cookie.
	 */
	async createSession(): Promise<{ token: string; expiresAt: number }> {
		const token = randomBytes(32).toString("base64url");
		const issuedAt = this.now();
		const expiresAt = issuedAt + SESSION_ABSOLUTE_MAX_MS;
		await this.store.createManagementSession({
			tokenHash: hashSessionToken(token),
			createdAt: issuedAt,
			expiresAt,
			lastSeenAt: issuedAt,
		});
		return { token, expiresAt };
	}

	/**
	 * Is this token hash still a live session? Both ceilings apply, and an
	 * expired row is deleted on the way out so a dead session does not linger
	 * until the next sweep.
	 */
	async isSessionLive(tokenHash: string): Promise<boolean> {
		const session = await this.store.getManagementSession(tokenHash);
		if (!session) return false;
		const now = this.now();
		if (
			session.expiresAt <= now ||
			now - session.lastSeenAt >= SESSION_IDLE_MAX_MS
		) {
			await this.store.deleteManagementSession(tokenHash).catch(() => 0);
			return false;
		}
		return true;
	}

	/**
	 * The OPTIONAL-session check: reports what is true without deciding whether
	 * the caller may proceed. `/api/auth/status` needs exactly this — running it
	 * through the request gate would report "authenticated" for a public route
	 * and make the endpoint always claim a session.
	 */
	async checkRequest(req: Request): Promise<SessionCheck> {
		const configured = await this.isConfigured();
		if (!configured) {
			return { configured: false, authenticated: false, tokenHash: null };
		}
		const token = readSessionCookie(req);
		if (!token) {
			return { configured: true, authenticated: false, tokenHash: null };
		}
		const tokenHash = hashSessionToken(token);
		if (!(await this.isSessionLive(tokenHash))) {
			return { configured: true, authenticated: false, tokenHash: null };
		}
		// Best-effort, conditional, and never awaited into the decision: the
		// caller's access does not depend on this write landing, and the write is
		// skipped outright unless the stored value is already an hour stale.
		void this.store
			.touchManagementSession(
				tokenHash,
				this.now(),
				this.now() - SESSION_TOUCH_INTERVAL_MS,
			)
			.catch((error) => {
				log.debug(
					`Could not refresh session activity: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
		return { configured: true, authenticated: true, tokenHash };
	}

	/**
	 * The gate: may this request proceed onto the management API? Fail-open
	 * while no password is configured.
	 */
	async authorizeRequest(req: Request): Promise<boolean> {
		const check = await this.checkRequest(req);
		return !check.configured || check.authenticated;
	}

	/** Drop one session. Returns its token hash when a row was removed. */
	async destroySession(req: Request): Promise<string | null> {
		const token = readSessionCookie(req);
		if (!token) return null;
		const tokenHash = hashSessionToken(token);
		const removed = await this.store.deleteManagementSession(tokenHash);
		return removed > 0 ? tokenHash : null;
	}

	/** Remove sessions past either ceiling. Run at startup and hourly. */
	async sweepExpiredSessions(): Promise<number> {
		const now = this.now();
		return this.store.cleanupExpiredManagementSessions(
			now,
			now - SESSION_IDLE_MAX_MS,
		);
	}
}
