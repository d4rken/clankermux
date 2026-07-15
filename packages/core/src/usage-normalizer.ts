import type { AnthropicUsageData } from "@clankermux/types";
import { getModelFamily } from "./model-mappings";
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
 * A `weekly_scoped` entry qualifies when its `percent` is a finite number, its
 * scope model display name resolves to a known family, and its `resets_at`
 * parses to a finite FUTURE timestamp (a rolled-over window is stale, excluded).
 *
 * NOT thresholded on percent — callers decide exhaustion. `is_active` is carried
 * through for logging but never gates inclusion.
 */
function normalizeWeeklyScoped(
	data: AnthropicUsageData,
	nowMs: number,
): ScopedFamilyLimit[] {
	const results: ScopedFamilyLimit[] = [];
	for (const entry of data.limits ?? []) {
		if (entry.kind !== "weekly_scoped") continue;
		if (!isFiniteNumber(entry.percent)) continue;
		const resetsAtMs = parseResetMs(entry.resets_at);
		if (resetsAtMs === null || resetsAtMs <= nowMs) continue;
		const displayName = entry.scope?.model?.display_name ?? "";
		const family = getModelFamily(displayName);
		if (family === null) continue;
		results.push({
			family,
			percent: entry.percent,
			resetsAtMs,
			isActive: entry.is_active,
			displayName,
		});
	}
	return results;
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
		return { session: null, weeklyAll: null, weeklyScoped: [] };
	}
	return {
		session: normalizeSession(data),
		weeklyAll: normalizeWeeklyAll(data),
		weeklyScoped: normalizeWeeklyScoped(data, nowMs),
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
