/**
 * Version utility that works in both development and production environments
 */

// Read the ClankerMux release version straight from the repo-root package.json,
// the same way the dashboard does. A static import so the value is resolved by
// the bundler/runtime rather than by a filesystem probe that has no answer under
// a compiled binary.
import rootPackageJson from "../../../package.json";

// User-agent version for the requests ClankerMux originates itself, where there
// is no client user-agent to pass through. Hand-maintained: refresh it from
// `claude --version`.
export const CLAUDE_CLI_VERSION = "2.1.280";

/** The single cache for {@link getAppVersionSync}, which {@link getVersion} reads through. */
let cachedAppVersion: string | null = null;

/**
 * The ClankerMux release version, or null when it genuinely cannot be read.
 *
 * The repo-root package.json only, and NO fallback: a null is an honest "unknown
 * build", which the nullable provenance column (`account_tier_history.app_version`)
 * already allows.
 */
export function getAppVersionSync(): string | null {
	if (cachedAppVersion !== null) return cachedAppVersion;
	const version = (rootPackageJson as { version?: string }).version;
	if (typeof version !== "string" || version.trim() === "") return null;
	cachedAppVersion = version;
	return cachedAppVersion;
}

export async function getVersion(): Promise<string> {
	return getAppVersionSync() ?? "unknown";
}

/**
 * Extract Claude CLI version from a user-agent header
 * @param userAgent - The user-agent string to parse
 * @returns The extracted version string, or null if not found
 * @example
 * extractClaudeVersion("claude-cli/2.0.60 (external, cli)") // returns "2.0.60"
 * extractClaudeVersion("Mozilla/5.0...") // returns null
 */
export function extractClaudeVersion(userAgent: string | null): string | null {
	if (!userAgent) {
		return null;
	}

	// Match claude-cli/X.Y.Z pattern (handles semver with optional prerelease/build metadata)
	const match = userAgent.match(
		/claude-cli\/(\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?)/i,
	);
	return match ? match[1] : null;
}

// Track the most recent Claude CLI version seen from client requests
// This allows auto-refresh to use newer client versions even after app restart
let lastSeenClientVersion: string | null = null;

/**
 * Update the tracked client version from an incoming request
 * @param userAgent - The user-agent header from the client request
 */
export function trackClientVersion(userAgent: string | null): void {
	const version = extractClaudeVersion(userAgent);
	if (version) {
		lastSeenClientVersion = version;
	}
}

/**
 * Get the most recently seen client version, or fall back to the application version
 * @returns The client version if available, otherwise CLAUDE_CLI_VERSION
 */
export function getClientVersion(): string {
	return lastSeenClientVersion || CLAUDE_CLI_VERSION;
}
