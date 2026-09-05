import type { AnthropicUsageData } from "@clankermux/types";
import { getModelFamily, type ModelFamily } from "./model-mappings";
import type { ScopedFamilyLimit } from "./scoped-limits";

/**
 * Central normalizer for Anthropic account usage. Anthropic historically
 * reported usage as flat windows (`five_hour`, `seven_day`, …) and is moving
 * toward a generic `limits[]` array that will eventually be the ONLY source
 * (the flat keys are being dropped). Routing-critical reads must not gate on
 * the flat keys, or a `limits[]`-only payload reads as "0% used / no capacity
 * signal" everywhere.
 *
 * This module produces one shape from either payload form. **The linchpin
 * contract: every window is `null` when there is no account-level evidence,
 * NEVER 0** — a concrete 0 falsely reads as "plenty of headroom" and (e.g.)
 * clears a rate-limit cooldown that should hold.
 */

/** A single normalized usage window. `utilization` is always a finite number. */
export interface NormalizedUsageWindow {
	/** Utilization percent 0..100. */
	utilization: number;
	/** Parsed reset time in epoch ms, or null when absent/unparseable. */
	resetMs: number | null;
}

/**
 * Normalized Anthropic usage. Windows are `null` when no account-level evidence
 * exists for them (never a concrete 0). `weeklyScoped` lists every present
 * per-model-family weekly window (callers decide exhaustion).
 */
export interface NormalizedAnthropicUsage {
	/** 5-hour / account-session window. */
	session: NormalizedUsageWindow | null;
	/** Account-wide weekly window. */
	weeklyAll: NormalizedUsageWindow | null;
	/** Every present per-family scoped weekly window (finite future reset). */
	weeklyScoped: ScopedFamilyLimit[];
	/**
	 * Every family named by ANY `weekly_scoped` entry whose scope display name
	 * resolves, whether or not the entry survived into {@link weeklyScoped}.
	 * De-duplicated, in first-seen order.
	 *
	 * Presence is evidence that the provider knows the family for this account;
	 * `weeklyScoped` is the subset usable as a reading. A consumer deciding
	 * whether an account has NOT used a family must test presence, not the usable
	 * list, or a malformed entry (non-finite `percent`, unparseable or elapsed
	 * `resets_at`) reads as no entry — and "we could not read it" becomes the
	 * much stronger claim "this family was never touched".
	 */
	weeklyScopedPresent: ModelFamily[];
	/**
	 * Families whose `weekly_scoped` entry is the IDLE form: `percent === 0` with
	 * `resets_at` absent. De-duplicated, in first-seen order.
	 *
	 * This is how Anthropic states a window with no usage this week when it does
	 * not omit the entry outright (observed live 2026-09-05; see
	 * `packages/types/src/account.ts:190-194`, which documents the same
	 * `{utilization: 0, resets_at: null}` idle form for the 5-hour window). A
	 * window that has not opened has no reset instant yet, so the entry carries
	 * none.
	 *
	 * A subset of {@link weeklyScopedPresent} and NEVER of {@link weeklyScoped}:
	 * the entry has no usable reset, so it is not a reading. Two neighbouring
	 * shapes are deliberately NOT idle — an entry at `percent: 0` with a valid
	 * FUTURE reset is an ordinary reading (the window opened and nothing has been
	 * spent yet), and `percent > 0` with `resets_at: null` is present-only, since
	 * something was spent and only the reset is missing.
	 */
	weeklyScopedIdle: ModelFamily[];
}

/** Parse an ISO reset timestamp to epoch ms, or null when absent/unparseable. */
function parseResetMs(resetsAt: string | null | undefined): number | null {
	if (!resetsAt) return null;
	const ms = Date.parse(resetsAt);
	return Number.isFinite(ms) ? ms : null;
}

/** True iff `v` is a usable (finite) numeric utilization/percent. */
function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/**
 * Resolve the account-session (5-hour) window. Prefers the flat `five_hour`
 * window (numeric utilization); else the `limits[]` entry with
 * `kind === "session"`; else null.
 */
function normalizeSession(
	data: AnthropicUsageData,
): NormalizedUsageWindow | null {
	const flat = data.five_hour;
	if (flat && isFiniteNumber(flat.utilization)) {
		return {
			utilization: flat.utilization,
			resetMs: parseResetMs(flat.resets_at),
		};
	}
	for (const entry of data.limits ?? []) {
		if (entry.kind === "session" && isFiniteNumber(entry.percent)) {
			return {
				utilization: entry.percent,
				resetMs: parseResetMs(entry.resets_at),
			};
		}
	}
	return null;
}

/**
 * Resolve the account-wide weekly window. Prefers the flat `seven_day` window
 * (numeric utilization); else the `limits[]` entry with `kind === "weekly_all"`;
 * else null.
 */
function normalizeWeeklyAll(
	data: AnthropicUsageData,
): NormalizedUsageWindow | null {
	const flat = data.seven_day;
	if (flat && isFiniteNumber(flat.utilization)) {
		return {
			utilization: flat.utilization,
			resetMs: parseResetMs(flat.resets_at),
		};
	}
	for (const entry of data.limits ?? []) {
		if (entry.kind === "weekly_all" && isFiniteNumber(entry.percent)) {
			return {
				utilization: entry.percent,
				resetMs: parseResetMs(entry.resets_at),
			};
		}
	}
	return null;
}

/**
 * Collect every present per-model-family scoped weekly window from `limits[]`.
 * A `weekly_scoped` entry qualifies as a READING when its `percent` is a finite
 * number, its scope model display name resolves to a known family, and its
 * `resets_at` parses to a finite FUTURE timestamp (a rolled-over window is
 * stale, excluded).
 *
 * NOT thresholded on percent — callers decide exhaustion. `is_active` is carried
 * through for logging but never gates inclusion.
 *
 * `present` is the weaker claim from the same pass: the family was NAMED by an
 * entry, usable or not. `idle` is the narrower claim that the entry is the form
 * Anthropic emits for a window with no usage this week (0%, no reset). All
 * three are computed in one loop so they cannot drift over which entries exist.
 */
function normalizeWeeklyScoped(
	data: AnthropicUsageData,
	nowMs: number,
): {
	readings: ScopedFamilyLimit[];
	present: ModelFamily[];
	idle: ModelFamily[];
} {
	const readings: ScopedFamilyLimit[] = [];
	const present: ModelFamily[] = [];
	const idle: ModelFamily[] = [];
	for (const entry of data.limits ?? []) {
		if (entry.kind !== "weekly_scoped") continue;
		// Family resolution comes FIRST: an entry naming no known family says
		// nothing about any family, so it belongs to neither list. Everything
		// after this point is about whether the entry is usable, not whether it
		// exists.
		const displayName = entry.scope?.model?.display_name ?? "";
		const family = getModelFamily(displayName);
		if (family === null) continue;
		if (!present.includes(family)) present.push(family);
		// The idle form: nothing spent AND no reset instant, which is what an
		// unopened window looks like when the provider lists it instead of
		// omitting it. Tested before usability, because the entry is by
		// definition not a reading — it has no reset to parse.
		if (
			entry.percent === 0 &&
			(entry.resets_at === null || entry.resets_at === undefined) &&
			!idle.includes(family)
		) {
			idle.push(family);
		}
		if (!isFiniteNumber(entry.percent)) continue;
		const resetsAtMs = parseResetMs(entry.resets_at);
		if (resetsAtMs === null || resetsAtMs <= nowMs) continue;
		readings.push({
			family,
			percent: entry.percent,
			resetsAtMs,
			isActive: entry.is_active,
			displayName,
		});
	}
	return { readings, present, idle };
}

/**
 * Normalize an Anthropic usage payload (flat, `limits[]`-only, or mixed) into a
 * single shape. Missing evidence yields `null` windows and an empty
 * `weeklyScoped`, never a concrete 0. Safe for null/undefined/non-Anthropic
 * input (returns all-null).
 */
export function normalizeAnthropicUsage(
	data: AnthropicUsageData | null | undefined,
	nowMs: number,
): NormalizedAnthropicUsage {
	if (!data || typeof data !== "object") {
		return {
			session: null,
			weeklyAll: null,
			weeklyScoped: [],
			weeklyScopedPresent: [],
			weeklyScopedIdle: [],
		};
	}
	const scoped = normalizeWeeklyScoped(data, nowMs);
	return {
		session: normalizeSession(data),
		weeklyAll: normalizeWeeklyAll(data),
		weeklyScoped: scoped.readings,
		weeklyScopedPresent: scoped.present,
		weeklyScopedIdle: scoped.idle,
	};
}

/**
 * Representative account-wide utilization = the max of the session and weekly
 * windows, or `null` when BOTH are absent (no evidence). Deliberately does NOT
 * fold `weeklyScoped` into account-wide utilization (a single spent family is
 * not the account) and does NOT treat any `extra_usage` as headroom.
 */
export function getRepresentativeUtilization(
	normalized: NormalizedAnthropicUsage,
): number | null {
	const utils: number[] = [];
	if (normalized.session) utils.push(normalized.session.utilization);
	if (normalized.weeklyAll) utils.push(normalized.weeklyAll.utilization);
	return utils.length > 0 ? Math.max(...utils) : null;
}

/**
 * True iff `data` carries Anthropic-style usage evidence: a flat `five_hour`
 * or `seven_day` window, OR a non-empty `limits[]` array. Replaces the old
 * "both flat keys present" guards, which reject `limits[]`-only payloads.
 */
export function isAnthropicUsageShape(
	data: AnthropicUsageData | null | undefined,
): boolean {
	if (!data || typeof data !== "object") return false;
	if ("five_hour" in data || "seven_day" in data) return true;
	const limits = (data as AnthropicUsageData).limits;
	return Array.isArray(limits) && limits.length > 0;
}

/** One window the usage payload reports, as the staleness test sees it. */
export interface ObservedWindow {
	/** The window's `resets_at` in epoch ms. */
	resetMs: number;
	/** Its utilization percent, or null when the payload did not say. */
	utilization: number | null;
}

/**
 * Every window with a parseable reset the payload reports, in no particular
 * order: the flat windows (`five_hour`, `seven_day`, `seven_day_oauth_apps`,
 * `seven_day_opus`, `seven_day_sonnet`) plus EVERY `limits[]` entry regardless
 * of `kind`, family resolution or whether the reset has already elapsed.
 *
 * Deliberately broader than {@link normalizeAnthropicUsage}, which excludes
 * unknown families and rolled-over scoped windows because routing must not act
 * on them. This collector answers a different question: "is the reset we have
 * RECORDED for this account still owned by a window the provider reports as
 * spent?" Dropping entries here would turn a correct recorded reset into a
 * false positive for staleness.
 *
 * Windows without a `resets_at` are not windows for this purpose: a reset
 * that is null cannot own a recorded deadline. The flat `extra_usage` field is
 * not collected: it is a monthly billing bucket, not a rate-limit window, and
 * carries no `resets_at` in any payload shape seen. A `limits[]` entry of ANY
 * kind is collected, so an overage-kind entry with a `resets_at` would count.
 */
export function collectObservedWindows(
	data: AnthropicUsageData | null | undefined,
): ObservedWindow[] {
	if (!data || typeof data !== "object") return [];
	const out: ObservedWindow[] = [];
	const add = (
		window:
			| { utilization?: number | null; resets_at?: string | null }
			| null
			| undefined,
		utilization: number | null | undefined,
	) => {
		const resetMs = parseResetMs(window?.resets_at);
		if (resetMs === null) return;
		out.push({
			resetMs,
			utilization: isFiniteNumber(utilization) ? utilization : null,
		});
	};
	add(data.five_hour, data.five_hour?.utilization);
	add(data.seven_day, data.seven_day?.utilization);
	add(data.seven_day_oauth_apps, data.seven_day_oauth_apps?.utilization);
	add(data.seven_day_opus, data.seven_day_opus?.utilization);
	add(data.seven_day_sonnet, data.seven_day_sonnet?.utilization);
	for (const entry of data.limits ?? []) add(entry, entry?.percent);
	return out;
}
