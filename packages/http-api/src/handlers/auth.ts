import type { PasswordBinding } from "@clankermux/database";
import { jsonResponse } from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import {
	LOGIN_MAX_BODY_BYTES,
	LoginThrottle,
} from "../services/login-throttle";
import {
	clearedSessionCookieHeader,
	MAX_PASSWORD_BYTES,
	type SessionAuthService,
	sessionCookieHeader,
} from "../services/session-auth-service";
import { closeStreamsForSession } from "../services/session-stream-registry";

const log = new Logger("AuthHandlers");

/** Response of `GET /api/auth/status`. */
export interface AuthStatusResponse {
	/** A management password is set — the API is gated. */
	configured: boolean;
	/** This request carried a live session cookie. */
	authenticated: boolean;
}

/**
 * Read a bounded JSON body. Returns null when the body is absent, too large,
 * or not an object — every one of which must be refused BEFORE anything
 * expensive runs.
 */
async function readBoundedJson(
	req: Request,
	maxBytes: number,
): Promise<Record<string, unknown> | null> {
	// A declared length over the cap is refused without reading the body at all.
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	let text: string;
	try {
		text = await req.text();
	} catch {
		return null;
	}
	// The declared length is a claim, not a guarantee (and may be absent on a
	// chunked body), so the real size is checked too.
	if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * `POST /api/auth/login` — exchange the management password for a session
 * cookie.
 *
 * The order of the checks is the point. Body size, JSON shape and password
 * length are all settled before the throttle is claimed, and the throttle
 * before scrypt runs, so a caller sending garbage cannot spend either the
 * derivation budget or the CPU.
 */
export function createAuthLoginHandler(
	sessionAuth: SessionAuthService,
	throttle: LoginThrottle = new LoginThrottle(),
) {
	return async (req: Request): Promise<Response> => {
		const body = await readBoundedJson(req, LOGIN_MAX_BODY_BYTES);
		const password = body?.password;
		if (typeof password !== "string" || password.length === 0) {
			return jsonResponse({ error: "Password required" }, 400);
		}
		if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
			return jsonResponse({ error: "Password too long" }, 400);
		}

		// Nothing to log in to. Reported rather than silently succeeding: a client
		// that got a 200 here would believe it holds a session it does not have.
		if (!(await sessionAuth.isConfigured())) {
			return jsonResponse(
				{
					error:
						"No management password is configured. Set one with: bun run auth:password --set",
				},
				409,
			);
		}

		const claim = throttle.tryAcquire();
		if (!claim.ok) {
			return jsonResponse({ error: "Too many login attempts" }, 429, {
				"Retry-After": String(claim.rejection.retryAfterSeconds),
			});
		}

		let binding: PasswordBinding | null;
		try {
			binding = await sessionAuth.verifyPassword(password);
		} finally {
			claim.release();
		}

		if (!binding) {
			// Deliberately no lockout and no attempt counter: on a single-user box
			// a lockout is a self-DoS. The throttle above is the whole defence.
			return jsonResponse({ error: "Invalid password" }, 401);
		}

		// The session is minted against the verifier the check actually ran on.
		// Derivation takes ~35ms, and an operator rotating the password inside
		// that window has already deleted every session; issuing one here anyway
		// would hand the revoked password 30 more days of access.
		const session = await sessionAuth.createSession(binding);
		if (!session) {
			log.warn(
				"A login raced a password rotation; no session was issued for the replaced password",
			);
			return jsonResponse({ error: "Invalid password" }, 401);
		}

		log.info("Management session established");
		return jsonResponse({ authenticated: true }, 200, {
			"Set-Cookie": sessionCookieHeader(session.token),
		});
	};
}

/**
 * `POST /api/auth/logout` — drop the session row, clear the cookie, and close
 * the SSE streams that session opened. Without the last part a logged-out tab
 * keeps receiving management events until its stream's next revalidation tick.
 *
 * Always 200: logging out with no session is the state the caller asked for.
 */
export function createAuthLogoutHandler(sessionAuth: SessionAuthService) {
	return async (req: Request): Promise<Response> => {
		const tokenHash = await sessionAuth.destroySession(req);
		if (tokenHash) {
			const closed = closeStreamsForSession(tokenHash);
			if (closed > 0) {
				log.debug(`Closed ${closed} stream(s) for the logged-out session`);
			}
		}
		return jsonResponse({ authenticated: false }, 200, {
			"Set-Cookie": clearedSessionCookieHeader(),
		});
	};
}

/**
 * `GET /api/auth/status` — is the API gated, and does this caller hold a
 * session?
 *
 * Uses the OPTIONAL-session check, never the request gate. The gate answers
 * "may this proceed", which for a public route is always yes — routing this
 * endpoint through it would make it report a session on every call, including
 * to a browser that has never logged in.
 */
export function createAuthStatusHandler(sessionAuth: SessionAuthService) {
	return async (req: Request): Promise<Response> => {
		const check = await sessionAuth.checkRequest(req);
		const response: AuthStatusResponse = {
			configured: check.configured,
			authenticated: check.authenticated,
		};
		return jsonResponse(response);
	};
}
