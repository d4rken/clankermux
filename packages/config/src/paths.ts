import { join } from "node:path";
import { readEnv } from "@clankermux/core";
import { getPlatformConfigDir } from "./paths-common";

export function resolveConfigPath(): string {
	// Check for explicit config path from environment.
	// readEnv honors CLANKERMUX_CONFIG_PATH and the legacy BETTER_CCFLARE_/ccflare_ names.
	const explicitPath = readEnv("CONFIG_PATH");
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	return join(configDir, "clankermux.json");
}
