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
