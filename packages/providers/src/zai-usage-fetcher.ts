import { Logger } from "@clankermux/logger";
import type { ZaiUsageData, ZaiUsageWindow } from "@clankermux/types";

const log = new Logger("ZaiUsageFetcher");

export type { ZaiUsageData, ZaiUsageWindow } from "@clankermux/types";

/**
 * Hard bound on the usage fetch, mirroring the Anthropic fetcher's guard.
 *
 * Without a signal the request could hang indefinitely. `usage-fetcher.ts`
 * tracks in-flight fetches in `inFlightFetches` and only deletes the entry in
 * `promise.finally()`, so a hung fetch wedges that account's polling slot for
 * the lifetime of the process -- and polling is the ONLY channel that observes a
 * locked account recovering.
 */
const USAGE_FETCH_TIMEOUT_MS = 5000;

/**
 * Quota rows that cap MODEL usage. Both spellings are accepted: the `lite` tier
 * serves `CREDIT_LIMIT`, other tiers may still serve `TOKENS_LIMIT`, and
 * nothing establishes the rename is complete.
 */
const TOKEN_QUOTA_TYPES: ReadonlySet<string> = new Set([
	"TOKENS_LIMIT",
	"CREDIT_LIMIT",
]);

/** Quota rows that cap the web tools rather than inference. */
const TIME_QUOTA_TYPES: ReadonlySet<string> = new Set([
	"TIME_LIMIT",
	"MCP_LIMIT",
]);

/** One entry of the `data.limits[]` array, as the endpoint serves it. */
interface ZaiLimitEntry {
	type?: string | null;
	unit?: number | null;
	number?: number | null;
	usage?: number | null;
	currentValue?: number | null;
	remaining?: number | null;
	percentage?: number | null;
	nextResetTime?: number | null;
}

/**
 * Outcome of one usage read.
 *
 * `unrecognized` is a THIRD state, distinct from data and failure: the endpoint
 * answered and every quota row it carried used a type this parser does not
 * know. There is nothing to cache, but nothing failed either — folding it into
 * a failure would back the poller off toward its 30-minute ceiling, spacing out
 * the warning that names the unknown type and aging the cache past its TTL.
 */
export type ZaiUsageFetchOutcome =
	| { status: "ok"; data: ZaiUsageData }
	| { status: "unrecognized" }
	| { status: "failed" };

const FAILED = { status: "failed" } as const;

/**
 * One quota row as a window, shared by every recognised type so the renamed and
 * legacy payloads cannot diverge.
 *
 * `used` is `usage - remaining`, the denominator minus what is left. The live
 * reading `{usage: 2000, currentValue: 0, remaining: 1999}` has one credit spent
 * with `currentValue` still reading 0, so `currentValue` is only the fallback
 * for a payload carrying no totals.
 */
function windowFrom(limit: ZaiLimitEntry, type: string): ZaiUsageWindow {
	const total = limit.usage;
	const remaining = limit.remaining;
	const used =
		typeof total === "number" &&
		Number.isFinite(total) &&
		typeof remaining === "number" &&
		Number.isFinite(remaining)
			? total - remaining
			: (limit.currentValue ?? 0);
	return {
		used,
		remaining: limit.remaining ?? 0,
		percentage: limit.percentage ?? 0,
		resetAt: limit.nextResetTime ?? null,
		type,
	};
}

/**
 * Read the account's quota windows from Zai's monitoring endpoint. Never
 * throws: every failure mode degrades to an outcome so provider operation is
 * unaffected.
 */
export async function fetchZaiUsage(
	apiKey: string,
): Promise<ZaiUsageFetchOutcome> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		USAGE_FETCH_TIMEOUT_MS,
	);
	try {
		const response = await fetch(
			"https://api.z.ai/api/monitor/usage/quota/limit",
			{
				method: "GET",
				headers: {
					"x-api-key": apiKey,
					Accept: "application/json",
				},
				signal: controller.signal,
			},
		);

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch Zai usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.z.ai/api/monitor/usage/quota/limit",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch Zai usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.z.ai/api/monitor/usage/quota/limit",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return FAILED;
		}

		const json = await response.json();

		// Validate response structure
		if (!json.success || !json.data || !Array.isArray(json.data.limits)) {
			log.warn("Invalid Zai usage response structure");
			return FAILED;
		}

		const limits = json.data.limits as ZaiLimitEntry[];
		const result: ZaiUsageData = {
			time_limit: null,
			tokens_limit: null,
			tokens_limit_weekly: null,
		};

		const tokenCount = limits.filter((limit) =>
			TOKEN_QUOTA_TYPES.has(limit.type ?? ""),
		).length;

		let recognized = 0;
		const unknownTypes = new Set<string>();

		// Parse each limit type
		for (const limit of limits) {
			const type = limit.type ?? "";
			if (TIME_QUOTA_TYPES.has(type)) {
				recognized++;
				result.time_limit = windowFrom(limit, "time_limit");
			} else if (TOKEN_QUOTA_TYPES.has(type)) {
				recognized++;
				// The upstream fixture identifies hours as unit 3 and weeks as unit 6.
				// Reset order is NOT duration order: the week can reset sooner.
				const key =
					limit.unit === 6 && limit.number === 1
						? "tokens_limit_weekly"
						: (limit.unit === 3 && limit.number === 5) ||
								(tokenCount === 1 && limit.unit == null && limit.number == null)
							? "tokens_limit"
							: null;
				if (!key || result[key]) {
					// Dropping an unknown quota could hide an exhausted window.
					// Report unavailable rather than publishing partial capacity.
					log.warn("Unrecognized or duplicate Zai token quota duration");
					return FAILED;
				}
				result[key] = windowFrom(limit, key);
			} else {
				unknownTypes.add(type || "(missing)");
			}
		}

		// Named on every payload, not only when nothing matched: a mixed payload
		// carrying one known and one renamed type would otherwise drop the renamed
		// window in silence.
		if (unknownTypes.size > 0) {
			log.warn(
				`Unrecognized Zai quota limit type(s): ${[...unknownTypes].join(", ")}`,
			);
		}
		if (recognized === 0 && limits.length > 0) {
			return { status: "unrecognized" };
		}

		return { status: "ok", data: result };
	} catch (error) {
		// An abort lands here too, so a timeout degrades to the existing
		// failure path rather than propagating.
		log.warn("Error fetching Zai usage data:", error);
		return FAILED;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Model quotas only: TIME_LIMIT caps web tools, not inference. */
export function getRepresentativeZaiTokenWindow(
	usage: ZaiUsageData | null,
): { name: "five_hour" | "seven_day"; window: ZaiUsageWindow } | null {
	let winner: {
		name: "five_hour" | "seven_day";
		window: ZaiUsageWindow;
	} | null = null;
	for (const [name, window] of [
		["five_hour", usage?.tokens_limit],
		["seven_day", usage?.tokens_limit_weekly],
	] as const) {
		if (!window || !Number.isFinite(window.percentage)) continue;
		if (
			!winner ||
			window.percentage > winner.window.percentage ||
			(window.percentage === winner.window.percentage &&
				(window.resetAt ?? Infinity) > (winner.window.resetAt ?? Infinity))
		) {
			winner = { name, window };
		}
	}
	return winner;
}

export function getRepresentativeZaiUtilization(
	usage: ZaiUsageData | null,
): number | null {
	return getRepresentativeZaiTokenWindow(usage)?.window.percentage ?? null;
}

export function getRepresentativeZaiWindow(
	usage: ZaiUsageData | null,
): string | null {
	return getRepresentativeZaiTokenWindow(usage)?.name ?? null;
}
