/**
 * Pure helpers for the Cache Keep-Alive "bridge horizon" control.
 *
 * The horizon (hours an idle, promoted 1h session stays bridged before the spend
 * budget gives up) and the risk factor are two views of the same quantity. The
 * conversion constants (`hoursPerRiskUnit`, `maxBridgeHours`, `refreshMinutes`) are
 * owned by the backend (bridge-policy) and returned by the cache-warming API — these
 * helpers take them as ARGUMENTS so the dashboard never hardcodes (and never drifts
 * from) the server's economics. All math is for the 1h-promoted bridge only.
 */

/** Clamp an hours value into [0, maxBridgeHours]; non-finite → 0. */
export function clampBridgeHours(
	hours: number,
	maxBridgeHours: number,
): number {
	if (!Number.isFinite(hours)) return 0;
	return Math.min(Math.max(hours, 0), Math.max(maxBridgeHours, 0));
}

/** Convert a target horizon (hours) → the derived risk factor, clamped to [0, 1]. */
export function hoursToRiskFactor(
	hours: number,
	hoursPerRiskUnit: number,
): number {
	if (!Number.isFinite(hours) || !(hoursPerRiskUnit > 0)) return 0;
	return Math.min(Math.max(hours / hoursPerRiskUnit, 0), 1);
}

/**
 * Approximate number of keepalive refreshes fired across the full horizon (used for
 * the "~N keepalives" hint). Returns 0 for a non-positive cadence/horizon.
 */
export function keepalivesForHours(
	hours: number,
	refreshMinutes: number,
): number {
	if (!Number.isFinite(hours) || !(refreshMinutes > 0) || hours <= 0) return 0;
	return (hours * 60) / refreshMinutes;
}
