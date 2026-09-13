/**
 * Centralized environment-variable reader: every configuration variable the
 * project reads is prefixed, and this is the only place that prefix is applied.
 * Going through it is what bars an unprefixed variable — a bare `HOST` or
 * `DEBUG` belonging to some other tool on the box is never picked up.
 *
 * Example: readEnv("DB_PATH") checks CLANKERMUX_DB_PATH.
 */
const ENV_PREFIXES = ["CLANKERMUX_"] as const;

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
 * authoritative variable is CLANKERMUX_DEBUG — never a bare `DEBUG`.
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
