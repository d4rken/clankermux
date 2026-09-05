/**
 * In-memory store of the last MID-WINDOW downward usage revision per account
 * window — a provider "gift" reset or an applied reset credit, observed as the
 * reported percentage dropping while `resets_at` stayed put.
 *
 * Why it exists: the lifetime-average exhaustion estimator divides the current
 * percentage by the time elapsed since the STRUCTURAL window start
 * (`resetMs − duration`). After a mid-window revision the percentage restarts
 * near zero but that denominator still spans the whole window, so the slope
 * collapses (an 11x-optimistic weekly ETA was the motivating measurement) and
 * every projection surface reads far too safe. The anchor recorded here is the
 * honest origin the estimator re-anchors to (`WindowExhaustionInput.anchor`).
 *
 * Mirrors `weekly-burn-slope.ts`: a module-level map written by the
 * usage-snapshot sampler, read by the HTTP handlers, empty after a restart
 * until the sampler's boot seed replays recent snapshot history. Like there,
 * two properties are load-bearing:
 *
 *  - **Observation order is enforced on WRITE.** `observeUsageReading` ignores
 *    a reading not strictly newer than the last one it saw, which makes the
 *    boot-seed replay plus the live tick idempotent — replaying history that
 *    was already observed changes nothing.
 *  - **An anchor only applies to the window it was observed in.** Every anchor
 *    carries the window's reset instant; `getUsageRevisionAnchor` returns it
 *    only when the caller's binding reset matches within the shared jitter
 *    tolerance, and a detected ROLLOVER discards the previous window's state
 *    outright. A stale anchor degrades to the structural estimate, never
 *    distorts the next window.
 */

import { isRevisionDrop, REVISION_MIN_DROP_PCT } from "@clankermux/core";
import type { UsageBurnAnchor } from "@clankermux/types";
import { RESET_JITTER_TOLERANCE_MS } from "@clankermux/types";

/**
 * Smallest drop in reported percentage (points) between consecutive readings
 * that counts as a revision. Re-exported from `@clankermux/core`: this registry
 * shares `isRevisionDrop` with the regression's `isFitBoundary`, so a 5.0 pp
 * drop anchors AND restarts the fit, or does neither. Integer quantization and
 * small refund wobble stay below it, a gift/credit reset (tens of points)
 * clears it easily.
 */
export { REVISION_MIN_DROP_PCT };

interface WindowObservationState {
	/** Newest observation consumed, for the write-side ordering guard. */
	lastObservedAtMs: number;
	/** Last non-null reading, the comparison baseline. */
	lastPct: number | null;
	/** Reset instant of the window the baseline belongs to (null = unknown). */
	lastResetMs: number | null;
	/** Last detected revision within the CURRENT window, if any. */
	anchor: UsageBurnAnchor | null;
}

type WindowKind = "five_hour" | "seven_day";

/** Keyed `${accountId}::${windowKind}` — accounts cannot collide. */
const states = new Map<string, WindowObservationState>();

function stateKey(accountId: string, windowKind: WindowKind): string {
	return `${accountId}::${windowKind}`;
}

function sameWindow(a: number | null, b: number | null): boolean {
	if (a == null || b == null) return false;
	return Math.abs(a - b) <= RESET_JITTER_TOLERANCE_MS;
}

/**
 * Feed one observed reading for `accountId`'s `windowKind` window.
 *
 * THE one detection path: the sampler's live 2-minute tick and its boot-time
 * replay of stored snapshots both go through here, in chronological order.
 * Detection rule, evaluated against the last NON-NULL baseline reading:
 *
 *  - reset moved beyond jitter tolerance → ROLLOVER: re-key the state to the
 *    new window and drop any anchor (the structural start is honest again);
 *  - reset stable and pct dropped by ≥ {@link REVISION_MIN_DROP_PCT} → a
 *    revision: anchor at THIS (post-drop) reading. The post-drop instant errs
 *    late, which overestimates the slope — the safe direction;
 *  - anything else → update the baseline and move on.
 *
 * A null pct never becomes a baseline and never clears one: a gap in evidence
 * is not a reading, and a drop visible across the gap still anchors.
 */
export function observeUsageReading(
	accountId: string,
	windowKind: WindowKind,
	reading: { pct: number | null; resetMs: number | null; observedAtMs: number },
): void {
	if (!Number.isFinite(reading.observedAtMs)) return;
	const key = stateKey(accountId, windowKind);
	const state = states.get(key);

	if (state !== undefined && reading.observedAtMs <= state.lastObservedAtMs) {
		return;
	}

	const pct =
		reading.pct != null && Number.isFinite(reading.pct) ? reading.pct : null;
	const resetMs =
		reading.resetMs != null && Number.isFinite(reading.resetMs)
			? reading.resetMs
			: null;

	if (state === undefined) {
		states.set(key, {
			lastObservedAtMs: reading.observedAtMs,
			lastPct: pct,
			lastResetMs: resetMs,
			anchor: null,
		});
		return;
	}

	state.lastObservedAtMs = reading.observedAtMs;

	// Rollover: the window this state described has ended. Everything about the
	// old window — baseline AND anchor — is void. Also taken when either side's
	// reset is unknown and the other's is known: without a shared identity a
	// drop cannot be attributed to a mid-window revision.
	const rolled =
		(state.lastResetMs != null || resetMs != null) &&
		!sameWindow(state.lastResetMs, resetMs);
	if (rolled) {
		state.lastPct = pct;
		state.lastResetMs = resetMs;
		state.anchor = null;
		return;
	}

	if (pct === null) return;

	if (
		state.lastPct != null &&
		isRevisionDrop(state.lastPct, pct) &&
		resetMs != null
	) {
		state.anchor = {
			anchorMs: reading.observedAtMs,
			anchorPct: pct,
			windowResetMs: resetMs,
		};
	}

	state.lastPct = pct;
	if (resetMs != null) state.lastResetMs = resetMs;
}

/**
 * The anchor for `accountId`'s `windowKind` window, or null.
 *
 * Null when nothing was detected, or when `bindingResetMs` (the reset of the
 * reading the CALLER is about to project from) does not name the same window
 * the anchor was observed in. The estimator re-validates on its own inputs;
 * this check merely avoids shipping an anchor that cannot apply.
 */
export function getUsageRevisionAnchor(
	accountId: string,
	windowKind: WindowKind,
	bindingResetMs: number | null,
): UsageBurnAnchor | null {
	const state = states.get(stateKey(accountId, windowKind));
	if (state === undefined || state.anchor === null) return null;
	if (!sameWindow(state.anchor.windowResetMs, bindingResetMs)) return null;
	return { ...state.anchor };
}

/** Drop one account's observation state, or everything (tests, account delete). */
export function clearUsageRevisionAnchors(accountId?: string): void {
	if (accountId === undefined) {
		states.clear();
		return;
	}
	states.delete(stateKey(accountId, "five_hour"));
	states.delete(stateKey(accountId, "seven_day"));
}
