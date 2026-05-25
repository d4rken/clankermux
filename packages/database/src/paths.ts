import { basename, join } from "node:path";
import { getLegacyConfigDirs, getPlatformConfigDir } from "@clankermux/config";
import { readEnv } from "@clankermux/core";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment.
	// readEnv honors CLANKERMUX_DB_PATH and the legacy BETTER_CCFLARE_/ccflare_ names.
	const explicitPath = readEnv("DB_PATH");
	if (explicitPath) {
		return explicitPath;
	}

	const configDir = getPlatformConfigDir();

	// Always use the same database path for consistency.
	// For development/testing, specify a different database using:
	// - Environment variable: CLANKERMUX_DB_PATH=/path/to/dev.db
	// - Command line flag: --db-path /path/to/dev.db
	// - .env file: CLANKERMUX_DB_PATH=/path/to/dev.db
	return join(configDir, "clankermux.db");
}

/**
 * Legacy database file paths, ordered newest first. Each legacy config
 * directory held a database named after the directory itself
 * (e.g. better-ccflare/better-ccflare.db, ccflare/ccflare.db). Used on first
 * run to adopt data from the most recent prior install.
 */
export function getLegacyDbPaths(): string[] {
	return getLegacyConfigDirs().map((dir) => join(dir, `${basename(dir)}.db`));
}

/**
 * Get the newest legacy database file path.
 * @deprecated prefer {@link getLegacyDbPaths} which exposes the full chain.
 */
export function getLegacyDbPath(): string {
	return getLegacyDbPaths()[0];
}
