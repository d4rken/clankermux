import { join } from "node:path";
import { getPlatformConfigDir } from "@clankermux/config";
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
