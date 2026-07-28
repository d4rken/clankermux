import { Logger } from "@clankermux/logger";

const log = new Logger("KiloUsageFetcher");

export interface KiloUsageData {
	microdollarsUsed: number;
	totalMicrodollarsAcquired: number;
	/** Remaining credits in USD */
	remainingUsd: number;
	/** Utilization as percentage 0-100 */
	utilizationPercent: number;
}

/**
 * Fetch usage data from Kilo's user endpoint
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

export async function fetchKiloUsageData(
	apiKey: string,
): Promise<KiloUsageData | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		USAGE_FETCH_TIMEOUT_MS,
	);
	try {
		const response = await fetch("https://api.kilo.ai/api/user", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch Kilo usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.kilo.ai/api/user",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch Kilo usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.kilo.ai/api/user",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return null;
		}

		const json = await response.json();

		const used: number = json.microdollars_used ?? 0;
		const acquired: number = json.total_microdollars_acquired ?? 0;
		const remaining = Math.max(0, acquired - used);
		const utilizationPercent =
			acquired > 0 ? Math.min(100, (used / acquired) * 100) : 0;

		return {
			microdollarsUsed: used,
			totalMicrodollarsAcquired: acquired,
			remainingUsd: remaining / 1_000_000,
			utilizationPercent,
		};
	} catch (error) {
		// An abort lands here too, so a timeout degrades to the existing
		// failure path (null) rather than propagating.
		log.warn("Error fetching Kilo usage data:", error);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Get the representative utilization percentage (0-100)
 */
export function getRepresentativeKiloUtilization(
	usage: KiloUsageData | null,
): number | null {
	if (!usage) return null;
	return usage.utilizationPercent;
}

/**
 * Get the representative window label
 */
export function getRepresentativeKiloWindow(
	usage: KiloUsageData | null,
): string | null {
	if (!usage) return null;
	return "credits";
}
