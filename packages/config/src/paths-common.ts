import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

/**
 * Base directory that holds the per-app config directory, following the
 * platform convention (LOCALAPPDATA/APPDATA on Windows, XDG on Linux/macOS).
 */
function getConfigBaseDir(): string {
	if (platform === "win32") {
		// Windows: Use LOCALAPPDATA or APPDATA
		return (
			process.env.LOCALAPPDATA ??
			process.env.APPDATA ??
			join(homedir(), "AppData", "Local")
		);
	}
	// Linux/macOS: Follow XDG Base Directory specification
	const xdgConfig = process.env.XDG_CONFIG_HOME;
	return xdgConfig ?? join(homedir(), ".config");
}

/**
 * Get the platform-specific configuration directory for ClankerMux.
 */
export function getPlatformConfigDir(): string {
	return join(getConfigBaseDir(), "clankermux");
}

/**
 * Legacy configuration directory names, newest first. The project was renamed
 * ccflare → better-ccflare → ClankerMux; on first run we adopt data from the
 * most recent legacy directory that still exists. Order matters: prefer the
 * newer "better-ccflare" install over the original "ccflare" one.
 */
const LEGACY_CONFIG_DIR_NAMES = ["better-ccflare", "ccflare"] as const;

/**
 * Get the legacy configuration directories for migration purposes, ordered
 * newest first.
 */
export function getLegacyConfigDirs(): string[] {
	const base = getConfigBaseDir();
	return LEGACY_CONFIG_DIR_NAMES.map((name) => join(base, name));
}

/**
 * Get the newest legacy configuration directory for migration purposes.
 * @deprecated prefer {@link getLegacyConfigDirs} which exposes the full chain.
 */
export function getLegacyConfigDir(): string {
	return getLegacyConfigDirs()[0];
}
