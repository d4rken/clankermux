import { Logger } from "@clankermux/logger";
import type { ZaiUsageData, ZaiUsageWindow } from "@clankermux/types";

const log = new Logger("ZaiUsageFetcher");

export type { ZaiUsageData, ZaiUsageWindow } from "@clankermux/types";

/**
 * Fetch usage data from Zai's monitoring usage endpoint
 * This is non-blocking - failures return null and won't affect provider operation
 */
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

export async function fetchZaiUsageData(
	apiKey: string,
): Promise<ZaiUsageData | null> {
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
			return null;
		}

		const json = await response.json();

		// Validate response structure
		if (!json.success || !json.data || !Array.isArray(json.data.limits)) {
			log.warn("Invalid Zai usage response structure");
			return null;
		}

		const limits = json.data.limits;
		const result: ZaiUsageData = {
			time_limit: null,
			tokens_limit: null,
			tokens_limit_weekly: null,
		};

		const tokenCount = limits.filter(
			(limit: { type?: string }) => limit.type === "TOKENS_LIMIT",
		).length;

		// Parse each limit type
		for (const limit of limits) {
			if (limit.type === "TIME_LIMIT") {
				result.time_limit = {
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: "time_limit",
				};
			} else if (limit.type === "TOKENS_LIMIT") {
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
					return null;
				}
				result[key] = {
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: key,
				};
			}
		}

		return result;
	} catch (error) {
		// An abort lands here too, so a timeout degrades to the existing
		// failure path (null) rather than propagating.
		log.warn("Error fetching Zai usage data:", error);
		return null;
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
