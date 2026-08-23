import type { KeyRunway } from "@clankermux/core";
import type { RunwayAccountSummary, RunwayWindowKind } from "@clankermux/types";
import { formatDurationDhm } from "./format-prediction";
import { runwayWindowLabel } from "./runway-display";

/**
 * Glance-level readings pulled from the account evidence `/api/runway` serves
 * alongside the outcomes.
 *
 * The runway figure answers WHEN quota runs out. These answer the two questions
 * a reader immediately has next — what is closest to running out, and when does
 * relief arrive — from data already in the same response, so no surface built
 * on them needs a second fetch.
 *
 * Everything here returns `null` rather than a zero when there is no reading.
 * A "0%" tightest window and a "0m" next reset are both real, meaningful
 * values, so neither may double as "we could not tell".
 */

/**
 * The accounts at least one ACTIVE key can route to.
 *
 * Scoped this way rather than to the headline key's own eligible set: when
 * several keys tie on outcome, which one the headline names is effectively
 * database row order, and hanging the sub-readings off that would make them
 * jump between unrelated accounts on every poll. The union is stable and is
 * what "the pool this dashboard is about" actually means.
 */
export function reachableAccounts(
	runways: KeyRunway[],
	accounts: RunwayAccountSummary[],
): RunwayAccountSummary[] {
	const reachable = new Set<string>();
	for (const runway of runways) {
		if (!runway.isActive) continue;
		for (const id of runway.eligibleAccountIds) reachable.add(id);
	}
	return accounts.filter((account) => reachable.has(account.id));
}

export interface TightestWindow {
	accountId: string;
	accountName: string;
	kind: RunwayWindowKind;
	utilizationPct: number;
	/** e.g. `weekly · 45%` — the sub-row value. */
	label: string;
	/**
	 * e.g. `Codex-1 weekly window, 45% consumed (observed 12m ago)` — the
	 * sub-row tooltip.
	 *
	 * The observation time is part of the sentence, not an ornament. These rows
	 * read the endpoint's DISPLAY view, which serves a reading up to 30 minutes
	 * old, so a percentage presented bare would let a half-hour-old figure pass
	 * as the current one.
	 */
	detail: string;
}

/**
 * The single window closest to being spent, across every account passed in.
 *
 * This is the binding constraint, which is deliberately NOT the pool average
 * the 5h/7d tiles beside it report: a pool at 30% with one account at 97% is
 * one account away from losing a route, and the average hides that.
 */
export function tightestWindow(
	accounts: RunwayAccountSummary[],
	now: number,
): TightestWindow | null {
	let tightest: TightestWindow | null = null;
	for (const account of accounts) {
		for (const window of account.windows) {
			const pct = window.utilizationPct;
			if (pct == null || !Number.isFinite(pct)) continue;
			if (tightest && tightest.utilizationPct >= pct) continue;
			const windowLabel = runwayWindowLabel(window.kind);
			// `usageAsOfMs` is null only when no window carried a utilization, and
			// we are standing on one, so in practice this is always stamped — the
			// guard is here so the sentence degrades rather than saying "NaN ago".
			const ageMs =
				account.usageAsOfMs == null ? null : now - account.usageAsOfMs;
			const observed =
				ageMs == null || !Number.isFinite(ageMs) || ageMs < 0
					? ""
					: ` (observed ${formatDurationDhm(ageMs)} ago)`;
			tightest = {
				accountId: account.id,
				accountName: account.name,
				kind: window.kind,
				utilizationPct: pct,
				label: `${windowLabel} · ${Math.round(pct)}%`,
				detail: `${account.name} ${windowLabel} window, ${Math.round(pct)}% consumed${observed}`,
			};
		}
	}
	return tightest;
}

/**
 * The soonest window reset still ahead of `now`, in ms from `now`.
 *
 * Resets in the past are skipped rather than clamped to zero: a reset instant
 * that has already passed means the reading predates the rollover, so the
 * window has already reset and the stored instant says nothing about the next
 * one.
 */
export function msUntilNextReset(
	accounts: RunwayAccountSummary[],
	now: number,
): number | null {
	let soonest: number | null = null;
	for (const account of accounts) {
		for (const window of account.windows) {
			const resetsAtMs = window.resetsAtMs;
			if (resetsAtMs == null || !Number.isFinite(resetsAtMs)) continue;
			if (resetsAtMs <= now) continue;
			if (soonest == null || resetsAtMs < soonest) soonest = resetsAtMs;
		}
	}
	return soonest == null ? null : soonest - now;
}
