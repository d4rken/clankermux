import type { UsageData, UsageWindow } from "../../usage-fetcher";

export interface ParseCodexUsageHeadersOptions {
	baseTimeMs?: number;
	allowRelativeResetAfter?: boolean;
	defaultUtilization?: number;
}

const DEFAULT_UTILIZATION = 0;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;

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

function pickWindowSlot(
	windowMinutes: number | null,
): "five_hour" | "seven_day" | null {
	if (windowMinutes === null) return null;
	if (windowMinutes <= FIVE_HOUR_WINDOW_MINUTES) return "five_hour";
	if (windowMinutes >= SEVEN_DAY_WINDOW_MINUTES) return "seven_day";
	return null;
}

function readWindow(
	headers: Headers,
	prefix: "primary" | "secondary",
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

	// Treat a window as present only when it has meaningful data.
	// Mirrors codex-rs behavior for empty (0%, 0min, no reset) placeholders.
	const hasMeaningfulWindowData =
		utilization !== 0 || windowMinutes !== 0 || resetsAt !== null;

	return {
		window: pickWindowSlot(windowMinutes),
		data: hasMeaningfulWindowData
			? toUsageWindow(utilization ?? defaultUtilization, resetsAt)
			: null,
	};
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
		(primary.window === "five_hour" ? primary.data : null) ??
		(secondary.window === "five_hour" ? secondary.data : null) ??
		(legacyFiveHourReset
			? toUsageWindow(defaultUtilization, legacyFiveHourReset)
			: null);
	const sevenDay =
		(primary.window === "seven_day" ? primary.data : null) ??
		(secondary.window === "seven_day" ? secondary.data : null) ??
		(legacySevenDayReset
			? toUsageWindow(defaultUtilization, legacySevenDayReset)
			: null);

	if (!fiveHour && !sevenDay) {
		return null;
	}

	return {
		five_hour: fiveHour ?? { utilization: defaultUtilization, resets_at: null },
		seven_day: sevenDay ?? { utilization: defaultUtilization, resets_at: null },
	};
}
