/**
 * Which management paths the session gate covers.
 *
 * Three classes, and the two narrow ones are the interesting ones:
 *
 *  - The auth endpoints themselves are public, or logging in would require
 *    already being logged in.
 *  - `/api/event_logging/batch` and `/api/system/package-manager` are Claude
 *    Code's own telemetry arriving at the ROOT of the port when a client is
 *    configured without a wire mount. They are not our management API at all;
 *    they have to keep falling through to the proxy's ingest prologue, which
 *    answers them with the 200 the CLI expects. Gating an agent client on a
 *    dashboard cookie breaks it.
 *  - Everything else under `/api` is management surface and needs a session.
 *
 * Exported as a pure function so the router boundary (the primary enforcement
 * point) and the auth service's path policy (defense in depth) read ONE
 * classification and cannot drift.
 */

/** Auth endpoints, reachable without a session by construction. */
const PUBLIC_AUTH_PATHS = new Set([
	"/api/auth/login",
	"/api/auth/logout",
	"/api/auth/status",
]);

/**
 * Claude Code telemetry that reaches us at the root. Mirrors
 * `isClaudeCodeInternalPath` in the server's request router; both lists are
 * exact-match and deliberately narrow.
 */
const CLAUDE_CODE_INTERNAL_PATHS = new Set([
	"/api/event_logging/batch",
	"/api/system/package-manager",
]);

export type ManagementAuthRequirement = "public" | "session";

/** True for the management namespace at the root of the port. */
export function isManagementPath(path: string): boolean {
	return path === "/api" || path.startsWith("/api/");
}

/** What `path` requires. Non-management paths are this policy's business. */
export function managementAuthRequirement(
	path: string,
): ManagementAuthRequirement {
	if (!isManagementPath(path)) return "public";
	if (PUBLIC_AUTH_PATHS.has(path)) return "public";
	if (CLAUDE_CODE_INTERNAL_PATHS.has(path)) return "public";
	return "session";
}
