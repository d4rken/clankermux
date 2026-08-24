/**
 * `Cache-Control: no-store` on every JSON snapshot this surface serves.
 *
 * Each payload describes ONE instant, and every consumer polls. A cached copy
 * is not a stale rendering of the truth, it is a different instant presented as
 * the current one — a desk panel showing a five-minute-old "out of quota" with
 * a fresh-looking `generatedAt` is worse than showing nothing. `no-store` rather
 * than `no-cache` because the intermediaries here (a reverse proxy in front of
 * the app, a device's own HTTP stack) should not retain the body at all.
 */
export const NO_STORE_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
};
