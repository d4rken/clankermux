import { Logger } from "@clankermux/logger";

const log = new Logger("MinimaxUsageFetcher");

/**
 * MiniMax Token Plan subscription usage endpoint.
 *
 *   GET https://www.minimax.io/v1/token_plan/remains
 *   Authorization: Bearer <API key>
 *
 * The response carries one entry per model class (e.g. "general", "video").
 * Only the `general` entry reflects text-inference quota; `video` is a separate
 * pool that must not be folded into utilization. The endpoint is a pure
 * metadata GET that costs zero quota; the Token Plan subscription key is
 * sufficient (no separate pay-as-you-go key required).
 *
 * Polling only — request forwarding still goes through the generic
 * anthropic-compatible path.
 */
export const MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT =
	"https://www.minimax.io/v1/token_plan/remains";

/**
 * Hard bound on the usage fetch, matching the convention used by every other
 * fetcher in this package. Without it a stalled MiniMax response keeps the
 * account's in-flight polling slot occupied for the lifetime of the process —
 * and polling is the only channel that observes a locked account recovering.
 */
const USAGE_FETCH_TIMEOUT_MS = 5000;

/** Model class whose quota we surface as the account's utilization. */
const TEXT_INFERENCE_MODEL_NAME = "general";

/**
 * One row of the `model_remains` array. Field semantics:
 *   - `*_remaining_percent` is REMAINING (0-100), not utilization.
 *   - `*_total_count` / `*_usage_count` are request/credit counts, NOT tokens.
 *   - `start_time` / `end_time` / `weekly_*_time` are epoch milliseconds.
 *   - `remains_time` / `weekly_remains_time` are millisecond durations.
 *   - The status enums are only known for healthy accounts (`1`); tolerate
 *     unknown values and never switch on them.
 */
export interface MinimaxModelRemains {
	model_name: string;
	current_interval_remaining_percent: number;
	current_interval_status: number;
	current_interval_total_count: number;
	current_interval_usage_count: number;
	start_time: number;
	end_time: number;
	remains_time: number;
	current_weekly_remaining_percent: number;
	current_weekly_status: number;
	current_weekly_total_count: number;
	current_weekly_usage_count: number;
	weekly_start_time: number;
	weekly_end_time: number;
	weekly_remains_time: number;
}

interface MinimaxBaseResponse {
	status_code?: number;
	status_msg?: string;
}

interface MinimaxRawResponse {
	base_resp?: MinimaxBaseResponse;
	model_remains?: MinimaxModelRemains[];
}

export interface MinimaxUsageWindow {
	/** Utilization percent (0-100). 0 = fully available, 100 = exhausted. */
	utilization: number;
	/** Remaining percent (0-100) straight from the API. */
	remainingPercent: number;
	/** Reset time as epoch milliseconds. */
	resetAt: number | null;
	/** Window length in ms, derived from `end_time - start_time` per entry. */
	intervalMs: number | null;
}

export interface MinimaxUsageData {
	/** 5h-style per-model-class window derived from the `general` entry. */
	five_hour: MinimaxUsageWindow | null;
	/** 7d weekly window derived from the same `general` entry. */
	seven_day: MinimaxUsageWindow | null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * A REMAINING percent we are willing to believe, or `null`.
 *
 * Out-of-range values are UNKNOWN, never clamped. Clamping fabricates evidence
 * in the most damaging direction available: a negative remaining became 100%
 * utilization (which can remove a HEALTHY account from routing) and a value
 * above 100 became 0% utilization (which hides a spent one). That is exactly the
 * `null`-means-unknown contract this fetcher has to honour —
 * `.claude/rules/rate-limiting-architecture.md` §1 / invariant 1: "unknown" must
 * stay distinct from BOTH 0% and 100%.
 */
function toRemainingPercent(value: unknown): number | null {
	if (!isFiniteNumber(value)) return null;
	if (value < 0 || value > 100) return null;
	return value;
}

/**
 * Invert the API's REMAINING percent into our UTILIZATION percent:
 * `utilization = 100 - remaining_percent`. Forgetting to invert would report
 * healthy accounts as exhausted and vice versa. The input is already validated
 * to 0-100 by {@link toRemainingPercent}, so the result is in range by
 * construction.
 */
function remainingToUtilization(remainingPercent: number): number {
	return 100 - remainingPercent;
}

function buildWindow(
	raw: MinimaxModelRemains,
	which: "interval" | "weekly",
): MinimaxUsageWindow | null {
	const fields = raw as unknown as Record<string, unknown>;
	const remainingField =
		which === "interval"
			? "current_interval_remaining_percent"
			: "current_weekly_remaining_percent";
	const startField = which === "interval" ? "start_time" : "weekly_start_time";
	const endField = which === "interval" ? "end_time" : "weekly_end_time";

	const remaining = toRemainingPercent(fields[remainingField]);
	if (remaining === null) return null;

	const start = fields[startField];
	const end = fields[endField];
	const startMs = isFiniteNumber(start) ? start : null;
	const endMs = isFiniteNumber(end) ? end : null;
	const intervalMs =
		startMs !== null && endMs !== null && endMs >= startMs
			? endMs - startMs
			: null;

	return {
		utilization: remainingToUtilization(remaining),
		remainingPercent: remaining,
		resetAt: endMs,
		intervalMs,
	};
}

/**
 * Pick the row representing the account's TEXT-inference quota.
 *
 * When no `general` entry exists this returns null rather than substituting
 * another row. `video` (and any other class) is a SEPARATE quota pool, and a
 * substituted reading would be surfaced as the account's text utilization —
 * so a spent video pool could report a healthy account as exhausted, or an
 * untouched one as free.
 *
 * This is the `null`-means-unknown contract (rate-limiting-architecture.md §1 /
 * invariant 1): "unknown" must stay distinct from BOTH 0% and 100%.
 */
function pickTextInferenceRow(
	modelRemains: MinimaxModelRemains[],
): MinimaxModelRemains | null {
	return (
		modelRemains.find(
			(entry) => entry?.model_name === TEXT_INFERENCE_MODEL_NAME,
		) ?? null
	);
}

/**
 * Parse a raw response body. Returns null on any structural problem so the
 * caller treats it as a transient failure (the endpoint consumes no quota, so a
 * retry from the poller is safe).
 */
export function parseMinimaxTokenPlanResponse(
	body: unknown,
): MinimaxUsageData | null {
	if (!body || typeof body !== "object") return null;
	const raw = body as MinimaxRawResponse;

	const statusCode = raw.base_resp?.status_code;
	if (typeof statusCode === "number" && statusCode !== 0) {
		log.warn(
			`Minimax usage returned base_resp.status_code=${statusCode}${
				raw.base_resp?.status_msg ? ` ${raw.base_resp.status_msg}` : ""
			}`,
		);
		return null;
	}

	if (!Array.isArray(raw.model_remains) || raw.model_remains.length === 0) {
		log.warn("Minimax usage response missing model_remains array");
		return null;
	}

	const row = pickTextInferenceRow(raw.model_remains);
	if (!row) return null;

	// Each window stands on its own evidence: an unusable percent in one leaves
	// that window null while the other is still reported. With NEITHER usable
	// there is no evidence at all, which is a failed poll, not a reading of zero.
	const five_hour = buildWindow(row, "interval");
	const seven_day = buildWindow(row, "weekly");

	if (!five_hour && !seven_day) return null;

	return { five_hour, seven_day };
}

/**
 * Fetch usage data from MiniMax's Token Plan usage endpoint. Failures return
 * null; this is non-blocking and never affects provider operation.
 */
export async function fetchMinimaxUsageData(
	apiKey: string,
): Promise<MinimaxUsageData | null> {
	const key = apiKey?.trim();
	if (!key) return null;

	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		USAGE_FETCH_TIMEOUT_MS,
	);
	try {
		const response = await fetch(MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(
				`Failed to fetch Minimax usage data: ${response.status} ${response.statusText}`,
				{
					status: response.status,
					statusText: response.statusText,
					url: MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT,
					timestamp: new Date().toISOString(),
				},
			);
			return null;
		}

		// The body read inherits the same abort signal: a stalled response with
		// headers flushed but no body would otherwise block indefinitely and hold
		// the in-flight polling slot.
		const body = await response.json();
		return parseMinimaxTokenPlanResponse(body);
	} catch (error) {
		// An abort lands here too, so a timeout degrades to the existing failure
		// path (null) rather than propagating.
		log.warn(
			"Error fetching Minimax usage data:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Representative utilization percent (0-100): the higher of the
 * per-model-class interval window and the weekly window, mirroring how the zai
 * fetcher treats its 5h / 7d surfaces.
 *
 * Returns null — never 0 — when there is no evidence.
 */
export function getRepresentativeMinimaxUtilization(
	usage: MinimaxUsageData | null,
): number | null {
	if (!usage) return null;
	const candidates = [usage.five_hour, usage.seven_day]
		.map((w) => w?.utilization)
		.filter((v): v is number => typeof v === "number");
	if (candidates.length === 0) return null;
	return Math.max(...candidates);
}

/**
 * Window label for the most-restrictive window, using the same labels the
 * accounts handler and /health surface use for Anthropic, so a MiniMax account
 * under 5h pressure sorts alongside other 5h-pressure accounts in the UI.
 */
export function getRepresentativeMinimaxWindow(
	usage: MinimaxUsageData | null,
): string | null {
	if (!usage) return null;
	const five = usage.five_hour;
	const seven = usage.seven_day;
	if (five && seven) {
		return five.utilization >= seven.utilization ? "five_hour" : "seven_day";
	}
	if (five) return "five_hour";
	if (seven) return "seven_day";
	return null;
}
