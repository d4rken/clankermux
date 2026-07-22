import type { AnthropicLimitEntry } from "@clankermux/types";
import type { UsageData, UsageWindow } from "../../usage-fetcher";

export interface ParseCodexUsageHeadersOptions {
	baseTimeMs?: number;
	allowRelativeResetAfter?: boolean;
	defaultUtilization?: number;
}

const DEFAULT_UTILIZATION = 0;
// Codex's backend reports window durations in SECONDS (RateLimitWindowSnapshot
// `limit_window_seconds`). The legacy header path reports them in minutes and
// converts to seconds before slotting, so both sources share one boundary set.
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export interface NormalizedCodexInputUsage {
	/** Total context occupied upstream, including cached tokens. */
	totalInputTokens: number;
	/** Anthropic's additive, uncached input token field. */
	inputTokens: number;
	cacheReadInputTokens: number;
}

/**
 * Convert Codex's cache-inclusive input total to Anthropic's additive usage
 * fields. OpenAI's Responses API `usage.input_tokens` counts cached tokens
 * toward the total; Anthropic's `input_tokens` is additive and excludes tokens
 * already reported via `cache_read_input_tokens`. Copying the inclusive total
 * into both fields double-counts cached tokens for clients and for any billing
 * derived from Anthropic-shaped usage (our `estimateCostUSD` charges
 * `input_tokens` and `cache_read_input_tokens` additively).
 */
export function normalizeCodexInputUsage(
	totalInputTokens: unknown,
	cachedTokens: unknown,
): NormalizedCodexInputUsage {
	const total =
		typeof totalInputTokens === "number" &&
		Number.isFinite(totalInputTokens) &&
		totalInputTokens >= 0
			? totalInputTokens
			: 0;
	const cached =
		typeof cachedTokens === "number" &&
		Number.isFinite(cachedTokens) &&
		cachedTokens >= 0
			? Math.min(cachedTokens, total)
			: 0;

	return {
		totalInputTokens: total,
		inputTokens: total - cached,
		cacheReadInputTokens: cached,
	};
}

function parseNumber(value: string | null): number | null {
	if (!value) return null;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(timestampMs: number | null): string | null {
	if (timestampMs === null || !Number.isFinite(timestampMs)) return null;
	try {
		return new Date(timestampMs).toISOString();
	} catch {
		return null;
	}
}

function parseResetAtSeconds(value: string | null): string | null {
	const parsed = parseNumber(value);
	if (parsed === null) return null;
	return toIsoString(parsed * 1000);
}

function parseResetAfterSeconds(
	value: string | null,
	baseTimeMs: number,
	allowRelativeResetAfter: boolean,
): string | null {
	if (!allowRelativeResetAfter || !Number.isFinite(baseTimeMs)) return null;
	const parsed = parseNumber(value);
	if (parsed === null) return null;
	return toIsoString(baseTimeMs + parsed * 1000);
}

function toUsageWindow(
	utilization: number | null,
	resetsAt: string | null,
): UsageWindow | null {
	if (utilization === null && resetsAt === null) return null;
	return {
		utilization: utilization ?? 0,
		resets_at: resetsAt,
	};
}

/**
 * Slot a Codex rate-limit window by its duration in SECONDS. Shared by the
 * legacy `x-codex-*` header path (which multiplies its minute values up first)
 * and the JSON `/wham/usage` parser so both agree on the 5h/7d boundaries.
 */
export function pickWindowSlot(
	windowSeconds: number | null,
): "five_hour" | "seven_day" | null {
	if (windowSeconds === null) return null;
	if (windowSeconds <= FIVE_HOUR_WINDOW_SECONDS) return "five_hour";
	if (windowSeconds >= SEVEN_DAY_WINDOW_SECONDS) return "seven_day";
	return null;
}

/**
 * Normalize a single Codex usage window into a `{ slot, data }` pair. Empty
 * placeholder windows (0%, 0-duration, no reset) collapse to `data: null`,
 * mirroring codex-rs. Reused by both the header parser and the JSON
 * `/wham/usage` parser so window semantics stay identical across sources.
 */
export function normalizeCodexWindow(
	utilization: number | null,
	windowSeconds: number | null,
	resetsAt: string | null,
	defaultUtilization: number = DEFAULT_UTILIZATION,
): { slot: "five_hour" | "seven_day" | null; data: UsageWindow | null } {
	const hasMeaningfulWindowData =
		utilization !== 0 || windowSeconds !== 0 || resetsAt !== null;
	return {
		slot: pickWindowSlot(windowSeconds),
		data: hasMeaningfulWindowData
			? toUsageWindow(utilization ?? defaultUtilization, resetsAt)
			: null,
	};
}

function readWindow(
	headers: Headers,
	prefix: string,
	baseTimeMs: number,
	allowRelativeResetAfter: boolean,
	defaultUtilization: number,
): {
	window: "five_hour" | "seven_day" | null;
	data: UsageWindow | null;
} {
	const windowMinutes = parseNumber(
		headers.get(`x-codex-${prefix}-window-minutes`),
	);
	const utilization = parseNumber(
		headers.get(`x-codex-${prefix}-used-percent`),
	);
	const resetsAt =
		parseResetAtSeconds(headers.get(`x-codex-${prefix}-reset-at`)) ??
		parseResetAfterSeconds(
			headers.get(`x-codex-${prefix}-reset-after-seconds`),
			baseTimeMs,
			allowRelativeResetAfter,
		);

	const windowSeconds = windowMinutes === null ? null : windowMinutes * 60;
	const { slot, data } = normalizeCodexWindow(
		utilization,
		windowSeconds,
		resetsAt,
		defaultUtilization,
	);
	return { window: slot, data };
}

export interface CodexCreditsInfo {
	hasCredits: boolean;
	balance: number | null; // rounded to 2 decimals; null when absent/unlimited-only/malformed
	unlimited: boolean;
	planType: string | null;
	weeklyUsedPct: number | null; // x-codex-secondary-used-percent as a finite number, else null
}

function readHeader(
	headers: Headers | Record<string, string>,
	key: string,
): string | null {
	if (headers instanceof Headers) return headers.get(key);
	return headers[key] ?? null;
}

function parseBoolean(value: string | null): boolean {
	return value != null && value.toLowerCase() === "true";
}

export function parseCodexCreditsHeaders(
	headers: Headers | Record<string, string>,
): CodexCreditsInfo | null {
	const hasCreditsRaw = readHeader(headers, "x-codex-credits-has-credits");
	// Absent header signals a non-credits-aware response.
	if (hasCreditsRaw === null) return null;

	const balanceRaw = parseNumber(
		readHeader(headers, "x-codex-credits-balance"),
	);
	const balance =
		balanceRaw === null ? null : Math.round(balanceRaw * 100) / 100;

	return {
		hasCredits: parseBoolean(hasCreditsRaw),
		balance,
		unlimited: parseBoolean(readHeader(headers, "x-codex-credits-unlimited")),
		planType: readHeader(headers, "x-codex-plan-type"),
		weeklyUsedPct: parseNumber(
			readHeader(headers, "x-codex-secondary-used-percent"),
		),
	};
}

/** True when the account is on paid credits past its weekly limit (real financial risk). */
export function isCodexOnCredits(info: CodexCreditsInfo | null): boolean {
	// Early return (not `info !== null && …`) so biome's --unsafe optional-chain
	// rule can't rewrite this into `info?.hasCredits`, which would widen the
	// result to `boolean | undefined` and break the return type.
	if (info === null) return false;
	return (
		info.hasCredits &&
		!info.unlimited &&
		info.weeklyUsedPct !== null &&
		info.weeklyUsedPct >= 100
	);
}

type ReadWindowResult = {
	window: "five_hour" | "seven_day" | null;
	data: UsageWindow | null;
};

/**
 * Pick the window whose slot matches `slot`, preferring the `primary` reading
 * over `secondary` when both land in the same slot. Shared by the account-wide
 * (`parseCodexUsageHeaders`) and per-family (`parseCodexScopedLimits`) paths so
 * the "primary wins, secondary is the fallback" rule lives in one place.
 */
function pickWindowBySlot(
	primary: ReadWindowResult,
	secondary: ReadWindowResult,
	slot: "five_hour" | "seven_day",
): UsageWindow | null {
	return (
		(primary.window === slot ? primary.data : null) ??
		(secondary.window === slot ? secondary.data : null)
	);
}

/**
 * Discover per-model Codex limit families and emit each one's WEEKLY window as a
 * synthetic `AnthropicLimitEntry`. Codex's backend advertises a family via an
 * `x-codex-<family>-limit-name` header (value = human display name, e.g.
 * "GPT-5.3-Codex-Spark") and then reports that family's quota under prefixed
 * windows `x-codex-<family>-primary-*` / `-secondary-*`. The un-prefixed
 * `primary`/`secondary` windows (the account-wide limit) are handled separately
 * by `parseCodexUsageHeaders` and are NOT touched here.
 *
 * Families are classified by window duration, not by the primary/secondary name:
 * the weekly window is whichever prefix slots to `seven_day` (preferring the
 * higher-minute `primary` when both somehow qualify). The dashboard renders these
 * `weekly_scoped` entries as per-model "secondary" cards via a shape-gated path,
 * so we only emit when both a finite `percent` and a non-null `resets_at` are
 * present (the client filter requires both plus a display name).
 */
export function parseCodexScopedLimits(
	headers: Headers,
	options: { baseTimeMs: number; allowRelativeResetAfter: boolean },
): AnthropicLimitEntry[] {
	const { baseTimeMs, allowRelativeResetAfter } = options;
	// Map family codename (capture group) -> display name (header value). The
	// `-limit-name` suffix keeps `x-codex-active-limit` from matching.
	const familyNamePattern = /^x-codex-([a-z0-9]+)-limit-name$/i;
	const families = new Map<string, string>();
	headers.forEach((value, key) => {
		const match = familyNamePattern.exec(key);
		if (!match) return;
		families.set(match[1].toLowerCase(), value);
	});

	const limits: AnthropicLimitEntry[] = [];
	// Alphabetical order keeps the emitted array deterministic across runs.
	for (const codename of [...families.keys()].sort()) {
		const displayName = families.get(codename) as string;
		const primary = readWindow(
			headers,
			`${codename}-primary`,
			baseTimeMs,
			allowRelativeResetAfter,
			DEFAULT_UTILIZATION,
		);
		const secondary = readWindow(
			headers,
			`${codename}-secondary`,
			baseTimeMs,
			allowRelativeResetAfter,
			DEFAULT_UTILIZATION,
		);
		// Prefer the primary weekly window; fall back to secondary if that is where
		// the seven-day window landed. Empty placeholder windows collapse to null.
		const weekly = pickWindowBySlot(primary, secondary, "seven_day");
		if (!weekly) continue;
		if (!Number.isFinite(weekly.utilization) || weekly.resets_at === null) {
			continue;
		}
		limits.push({
			kind: "weekly_scoped",
			group: "codex",
			percent: weekly.utilization,
			resets_at: weekly.resets_at,
			scope: { model: { id: displayName, display_name: displayName } },
			is_active: true,
		});
	}
	return limits;
}

export function parseCodexUsageHeaders(
	headers: Headers,
	options: ParseCodexUsageHeadersOptions = {},
): UsageData | null {
	const {
		baseTimeMs = Date.now(),
		allowRelativeResetAfter = true,
		defaultUtilization = DEFAULT_UTILIZATION,
	} = options;
	const primary = readWindow(
		headers,
		"primary",
		baseTimeMs,
		allowRelativeResetAfter,
		defaultUtilization,
	);
	const secondary = readWindow(
		headers,
		"secondary",
		baseTimeMs,
		allowRelativeResetAfter,
		defaultUtilization,
	);

	const legacyFiveHourReset = parseResetAtSeconds(
		headers.get("x-codex-5h-reset-at"),
	);
	const legacySevenDayReset = parseResetAtSeconds(
		headers.get("x-codex-7d-reset-at"),
	);

	const fiveHour =
		pickWindowBySlot(primary, secondary, "five_hour") ??
		(legacyFiveHourReset
			? toUsageWindow(defaultUtilization, legacyFiveHourReset)
			: null);
	const sevenDay =
		pickWindowBySlot(primary, secondary, "seven_day") ??
		(legacySevenDayReset
			? toUsageWindow(defaultUtilization, legacySevenDayReset)
			: null);

	if (!fiveHour && !sevenDay) {
		return null;
	}

	const limits = parseCodexScopedLimits(headers, {
		baseTimeMs,
		allowRelativeResetAfter,
	});

	const usage: UsageData = {
		five_hour: fiveHour ?? { utilization: defaultUtilization, resets_at: null },
		seven_day: sevenDay ?? { utilization: defaultUtilization, resets_at: null },
	};
	// Only attach `limits` when a per-model family surfaced — an empty array would
	// add noise the downstream filter has to strip.
	if (limits.length > 0) {
		usage.limits = limits;
	}
	return usage;
}
