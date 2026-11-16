/**
 * Field names whose values never reach the browser console, compared after
 * lowercasing and dropping `_`/`-`: `apiKey`, `api_key` and `API-KEY` all
 * match `apikey`. Matching is exact, so `apiKeys` (a filter list of key ids)
 * and `hasRefreshToken` (a boolean) stay readable.
 */
const SECRET_FIELDS = new Set([
	"apikey",
	"token",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"secret",
	"clientsecret",
	"password",
	"code",
	"authorization",
	"cookie",
]);

export const REDACTED = "[REDACTED]";

function isSecretField(name: string): boolean {
	return SECRET_FIELDS.has(name.toLowerCase().replace(/[_-]/g, ""));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Copy of `value` with every secret field blanked, at any depth inside plain
 * objects and arrays.
 *
 *   { name: "z", apiKey: "sk-1", auth: { code: "c" } }
 *   => { name: "z", apiKey: "[REDACTED]", auth: { code: "[REDACTED]" } }
 *
 * Anything else (primitives, `Error`, `Date`, class instances) is returned as
 * is, so the console still renders it natively.
 */
export function redactForLog(value: unknown): unknown {
	return redact(value, new WeakMap());
}

function redact(value: unknown, seen: WeakMap<object, unknown>): unknown {
	if (Array.isArray(value)) {
		const cached = seen.get(value);
		if (cached) return cached;
		const out: unknown[] = [];
		seen.set(value, out);
		for (const item of value) out.push(redact(item, seen));
		return out;
	}
	if (!isPlainObject(value)) return value;
	const cached = seen.get(value);
	if (cached) return cached;
	const out: Record<string, unknown> = {};
	seen.set(value, out);
	for (const [key, field] of Object.entries(value)) {
		out[key] = isSecretField(key) ? REDACTED : redact(field, seen);
	}
	return out;
}
