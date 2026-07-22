/**
 * Centralized environment-variable reader that honors the project's rename
 * history. The project was renamed ccflare → better-ccflare → ClankerMux, and
 * each rename kept the previous env-var prefix working so existing deployments
 * (systemd drop-ins, .env files, shell profiles) keep functioning untouched.
 *
 * Lookup order for a given suffix (first defined wins):
 *   1. CLANKERMUX_<suffix>     — current
 *   2. BETTER_CCFLARE_<suffix> — legacy (accepted indefinitely)
 *   3. ccflare_<suffix>        — deep legacy (original project)
 *
 * Example: readEnv("DB_PATH") checks CLANKERMUX_DB_PATH, then
 * BETTER_CCFLARE_DB_PATH, then ccflare_DB_PATH.
 */
const ENV_PREFIXES = ["CLANKERMUX_", "BETTER_CCFLARE_", "ccflare_"] as const;

/**
 * Read an environment variable by suffix across the supported prefixes.
 * @param suffix the part after the prefix, e.g. "DB_PATH" or "HOST"
 * @returns the first defined value, or undefined if none are set
 */
export function readEnv(suffix: string): string | undefined {
	for (const prefix of ENV_PREFIXES) {
		const value = process.env[`${prefix}${suffix}`];
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

/**
 * Whether debug logging is enabled, resolved through {@link readEnv} so the one
 * authoritative variable is CLANKERMUX_DEBUG (with the usual BETTER_CCFLARE_ /
 * ccflare_ legacy fallbacks) — never a bare `DEBUG`.
 *
 * Enabled globally when the value is "1" or "true". When a `namespace` is given
 * (e.g. "model", "proxy"), also enabled if the value contains that namespace, so
 * `CLANKERMUX_DEBUG=model,proxy` turns on just those areas.
 */
export function isDebugEnabled(namespace?: string): boolean {
	// Guard non-Node environments (readEnv touches process.env directly).
	if (typeof process === "undefined" || !process.env) {
		return false;
	}
	const value = readEnv("DEBUG");
	if (value === undefined) {
		return false;
	}
	if (value === "1" || value === "true") {
		return true;
	}
	return namespace !== undefined && value.includes(namespace);
}
