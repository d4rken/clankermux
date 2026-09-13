import { join } from "node:path";
import { getPlatformConfigDir } from "@clankermux/config";
import { readEnv } from "@clankermux/core";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment.
	// readEnv reads the prefixed CLANKERMUX_DB_PATH; a bare DB_PATH is ignored.
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
