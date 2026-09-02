import {
	computeThrottleResumeAt,
	isAnthropicUsageShape,
	normalizeAnthropicUsage,
	type SupportedWindow,
} from "@clankermux/core";
import type { AnyUsageData } from "@clankermux/providers";
import {
	type Account,
	type AnthropicUsageData,
	PROVIDER_NAMES,
} from "@clankermux/types";

const RETRY_AFTER_SECONDS = 60;

interface UsageWindowSnapshot {
	utilization: number;
	resetAtMs: number;
	window: SupportedWindow;
	/**
	 * Data-derived window length, for providers that report one per reading
	 * instead of running windows of a fixed, known duration. Absent for every
	 * provider whose window length is implied by `window`.
	 */
	durationMs?: number;
}

export interface UsageThrottleSettings {
	fiveHourEnabled: boolean;
	weeklyEnabled: boolean;
}

export interface UsageThrottleStatus {
	throttleUntil: number | null;
	throttledWindows: SupportedWindow[];
}

function collectWindows(
	data: AnyUsageData | null,
	now: number,
	provider: string,
): UsageWindowSnapshot[] {
	if (!data || typeof data !== "object") return [];

	const windows: UsageWindowSnapshot[] = [];

	const pushWindow = (
		window: SupportedWindow,
		utilization: number | null | undefined,
		resetAtMs: number | null | undefined,
		durationMs?: number,
	) => {
		if (
			typeof utilization !== "number" ||
			!Number.isFinite(utilization) ||
			typeof resetAtMs !== "number" ||
			!Number.isFinite(resetAtMs)
		) {
			return;
		}

		windows.push({
			utilization,
			resetAtMs,
			window,
			...(durationMs === undefined ? {} : { durationMs }),
		});
	};

	// MiniMax must be matched on the PROVIDER, before the generic branch below.
	// Its payload carries top-level `five_hour`/`seven_day` keys too, so the
	// Anthropic-like branch matches it structurally and then reads `resets_at`,
	// which MiniMax never has — every window was silently dropped and the
	// account was never throttled.
	if (provider === PROVIDER_NAMES.MINIMAX) {
		const minimax = data as {
			five_hour?: {
				utilization?: number | null;
				resetAt?: number | null;
				intervalMs?: number | null;
			} | null;
			seven_day?: {
				utilization?: number | null;
				resetAt?: number | null;
				intervalMs?: number | null;
			} | null;
		};
		for (const [window, snapshot] of [
			["five_hour", minimax.five_hour],
			["seven_day", minimax.seven_day],
		] as const) {
			if (!snapshot) continue;
			// MiniMax windows have no fixed length: the duration is derived per
			// reading from the API's own start/end times. Without it there is no
			// pace line to compare against, and substituting the nominal 5h/7d
			// would invent evidence — so skip the window and fail open.
			const intervalMs = snapshot.intervalMs;
			if (
				typeof intervalMs !== "number" ||
				!Number.isFinite(intervalMs) ||
				intervalMs <= 0
			) {
				continue;
			}
			pushWindow(window, snapshot.utilization, snapshot.resetAt, intervalMs);
		}
		return windows;
	}

	if ("five_hour" in data && "seven_day" in data) {
		const anthropicLike = data as {
			five_hour?: { utilization?: number | null; resets_at?: string | null };
			seven_day?: { utilization?: number | null; resets_at?: string | null };
			seven_day_opus?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
			seven_day_sonnet?: {
				utilization?: number | null;
				resets_at?: string | null;
			};
		};

		pushWindow(
			"five_hour",
			anthropicLike.five_hour?.utilization,
			anthropicLike.five_hour?.resets_at
				? new Date(anthropicLike.five_hour.resets_at).getTime()
				: null,
		);
		pushWindow(
			"seven_day",
			anthropicLike.seven_day?.utilization,
			anthropicLike.seven_day?.resets_at
				? new Date(anthropicLike.seven_day.resets_at).getTime()
				: null,
		);
		pushWindow(
			"seven_day_opus",
			anthropicLike.seven_day_opus?.utilization,
			anthropicLike.seven_day_opus?.resets_at
				? new Date(anthropicLike.seven_day_opus.resets_at).getTime()
				: null,
		);
		pushWindow(
			"seven_day_sonnet",
			anthropicLike.seven_day_sonnet?.utilization,
			anthropicLike.seven_day_sonnet?.resets_at
				? new Date(anthropicLike.seven_day_sonnet.resets_at).getTime()
				: null,
		);
		return windows;
	}

	if ("tokens_limit" in data || "time_limit" in data) {
		const zai = data as {
			tokens_limit?: { percentage?: number; resetAt?: number | null } | null;
		};
		pushWindow(
			"tokens_limit",
			zai.tokens_limit?.percentage,
			zai.tokens_limit?.resetAt,
		);
		return windows;
	}

	if ("weekly" in data && "monthly" in data && "five_hour" in data) {
		const alibaba = data as {
			five_hour?: { percentUsed?: number; resetAt?: number | null };
			weekly?: { percentUsed?: number; resetAt?: number | null };
			monthly?: { percentUsed?: number; resetAt?: number | null };
		};
		pushWindow(
			"five_hour",
			alibaba.five_hour?.percentUsed,
			alibaba.five_hour?.resetAt,
		);
		pushWindow("weekly", alibaba.weekly?.percentUsed, alibaba.weekly?.resetAt);
		pushWindow(
			"monthly",
			alibaba.monthly?.percentUsed,
			alibaba.monthly?.resetAt,
		);
		return windows;
	}

	// Anthropic `limits[]`-only (upstream is dropping the flat five_hour/seven_day
	// keys). Reached only when the flat-Anthropic branch above did NOT match (no
	// flat five_hour && seven_day pair), so it covers pure `limits[]` payloads and
	// partial-flat ones. Source session→five_hour, weeklyAll→seven_day, and the
	// per-family scoped weekly windows (opus/sonnet) from the normalizer so these
	// accounts still get proactive throttling.
	if (isAnthropicUsageShape(data as unknown as AnthropicUsageData)) {
		const normalized = normalizeAnthropicUsage(
			data as unknown as AnthropicUsageData,
			now,
		);
		if (normalized.session) {
			pushWindow(
				"five_hour",
				normalized.session.utilization,
				normalized.session.resetMs,
			);
		}
		if (normalized.weeklyAll) {
			pushWindow(
				"seven_day",
				normalized.weeklyAll.utilization,
				normalized.weeklyAll.resetMs,
			);
		}
		for (const scoped of normalized.weeklyScoped) {
			if (scoped.family === "opus") {
				pushWindow("seven_day_opus", scoped.percent, scoped.resetsAtMs);
			} else if (scoped.family === "sonnet") {
				pushWindow("seven_day_sonnet", scoped.percent, scoped.resetsAtMs);
			}
			// fable/haiku have no dedicated throttle window type — skipped.
		}
		return windows;
	}

	return windows;
}

function isWindowThrottlingEnabled(
	window: SupportedWindow,
	settings: UsageThrottleSettings,
): boolean {
	switch (window) {
		case "five_hour":
		case "daily":
		case "tokens_limit":
			return settings.fiveHourEnabled;
		case "seven_day":
		case "seven_day_opus":
		case "seven_day_sonnet":
		case "weekly":
		case "monthly":
			return settings.weeklyEnabled;
	}
}

/**
 * `provider` is REQUIRED: window shapes are not self-describing (MiniMax and
 * Anthropic both carry top-level `five_hour`/`seven_day` keys with different
 * field names inside), so structural detection alone silently reads the wrong
 * provider's payload. Making it required means the type checker, not a
 * production incident, catches a caller that forgets it.
 */
export function getUsageThrottleStatus(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
	provider: string,
): UsageThrottleStatus {
	const windows = collectWindows(data, now, provider);
	let throttleUntil: number | null = null;
	const throttledWindows: SupportedWindow[] = [];

	for (const window of windows) {
		if (!isWindowThrottlingEnabled(window.window, settings)) continue;
		const resumeAt = computeThrottleResumeAt(
			window.resetAtMs,
			window.window,
			window.utilization,
			now,
			window.durationMs,
		);
		if (resumeAt === null) continue;
		throttledWindows.push(window.window);
		if (throttleUntil === null || resumeAt > throttleUntil) {
			throttleUntil = resumeAt;
		}
	}

	return { throttleUntil, throttledWindows };
}

export function getUsageThrottleUntil(
	data: AnyUsageData | null,
	settings: UsageThrottleSettings,
	now = Date.now(),
	provider: string,
): number | null {
	return getUsageThrottleStatus(data, settings, now, provider).throttleUntil;
}

export function createUsageThrottledResponse(accounts: Account[]): Response {
	const names = accounts.map((account) => account.name).join(", ");
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "overloaded_error",
				message: `Usage throttling is delaying requests for account(s): ${names}. Retry after ${RETRY_AFTER_SECONDS} seconds.`,
			},
		}),
		{
			status: 529,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(RETRY_AFTER_SECONDS),
			},
		},
	);
}
