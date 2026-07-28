/**
 * MiniMax Token Plan usage polling.
 *
 * There is no MiniMax account on this deployment, so the endpoint cannot be
 * exercised live — everything here is driven from recorded/synthetic payload
 * shapes. The load-bearing cases:
 *
 *  - `remaining_percent` is REMAINING, not utilization. Forgetting the
 *    inversion reports healthy accounts as exhausted and vice versa.
 *  - `video` is a SEPARATE quota pool. A missing `general` row must yield
 *    `null`, never a substituted reading — "unknown" has to stay distinct from
 *    both 0% and 100% (rate-limiting-architecture.md §1 / invariant 1).
 *  - window length comes from each row's `end_time - start_time`, not a
 *    hardcoded 5h.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	fetchMinimaxUsageData,
	getRepresentativeMinimaxUtilization,
	getRepresentativeMinimaxWindow,
	MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT,
	parseMinimaxTokenPlanResponse,
} from "../minimax-usage-fetcher";
import { usageCache } from "../usage-fetcher";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOUR_MS = 24 * 60 * 60 * 1000;

type Row = {
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
};

function makeRow(overrides: Partial<Row> = {}): Row {
	const intervalStart = 1_700_000_000_000;
	const weeklyStart = 1_700_000_000_000;
	return {
		model_name: "general",
		current_interval_remaining_percent: 75,
		current_interval_status: 1,
		current_interval_total_count: 100,
		current_interval_usage_count: 25,
		start_time: intervalStart,
		end_time: intervalStart + FIVE_HOUR_MS,
		remains_time: FIVE_HOUR_MS,
		current_weekly_remaining_percent: 90,
		current_weekly_status: 1,
		current_weekly_total_count: 1000,
		current_weekly_usage_count: 100,
		weekly_start_time: weeklyStart,
		weekly_end_time: weeklyStart + SEVEN_DAY_MS,
		weekly_remains_time: SEVEN_DAY_MS,
		...overrides,
	};
}

describe("Minimax usage fetcher — parsing", () => {
	it("inverts remaining percent into utilization (75 remaining -> 25 utilized)", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0, status_msg: "ok" },
			model_remains: [makeRow()],
		});

		expect(parsed?.five_hour?.utilization).toBe(25);
		expect(parsed?.five_hour?.remainingPercent).toBe(75);
		expect(parsed?.seven_day?.utilization).toBe(10);
		expect(parsed?.seven_day?.remainingPercent).toBe(90);
	});

	it("picks the `general` row, ignoring the `video` row", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					model_name: "video",
					current_interval_remaining_percent: 5,
					current_weekly_remaining_percent: 5,
				}),
				makeRow({
					model_name: "general",
					current_interval_remaining_percent: 60,
					current_weekly_remaining_percent: 60,
				}),
			],
		});

		expect(parsed?.five_hour?.utilization).toBe(40);
		expect(parsed?.five_hour?.remainingPercent).toBe(60);
		expect(parsed?.seven_day?.utilization).toBe(40);
	});

	it("returns null when no `general` row is present instead of substituting video", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					model_name: "video",
					current_interval_remaining_percent: 5,
					current_weekly_remaining_percent: 5,
				}),
			],
		});

		// A separate quota pool must never become text utilization. Null keeps
		// "unknown" distinct from both 0% and 100%.
		expect(parsed).toBeNull();
		expect(getRepresentativeMinimaxUtilization(parsed)).toBeNull();
		expect(getRepresentativeMinimaxWindow(parsed)).toBeNull();
	});

	it("derives interval length per-row (general=5h, video=24h — not hardcoded)", () => {
		const start = 1_700_000_000_000;
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					model_name: "general",
					start_time: start,
					end_time: start + FIVE_HOUR_MS,
				}),
				makeRow({
					model_name: "video",
					current_interval_remaining_percent: 50,
					current_weekly_remaining_percent: 50,
					start_time: start,
					end_time: start + TWENTY_FOUR_HOUR_MS,
					remains_time: TWENTY_FOUR_HOUR_MS,
				}),
			],
		});

		expect(parsed?.five_hour?.intervalMs).toBe(FIVE_HOUR_MS);
		expect(parsed?.five_hour?.resetAt).toBe(start + FIVE_HOUR_MS);
		expect(parsed?.seven_day?.intervalMs).toBe(SEVEN_DAY_MS);
	});

	it("tolerates an unknown status enum value", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_status: 7,
					current_weekly_status: 7,
					current_interval_remaining_percent: 40,
					current_weekly_remaining_percent: 80,
				}),
			],
		});

		// Exhaustion comes purely from the percentages; the unrecognised enum is
		// never switched on.
		expect(parsed?.five_hour?.utilization).toBe(60);
		expect(parsed?.seven_day?.utilization).toBe(20);
	});

	it("returns null when base_resp.status_code is non-zero", () => {
		expect(
			parseMinimaxTokenPlanResponse({
				base_resp: { status_code: 1001, status_msg: "quota exceeded" },
				model_remains: [makeRow()],
			}),
		).toBeNull();
	});

	it("returns null for malformed payloads", () => {
		expect(parseMinimaxTokenPlanResponse(null)).toBeNull();
		expect(parseMinimaxTokenPlanResponse("not json")).toBeNull();
		expect(parseMinimaxTokenPlanResponse({})).toBeNull();
		expect(parseMinimaxTokenPlanResponse({ model_remains: [] })).toBeNull();
		expect(parseMinimaxTokenPlanResponse({ model_remains: "nope" })).toBeNull();
		// A `general` row with no usable percent in EITHER window is no evidence.
		expect(
			parseMinimaxTokenPlanResponse({
				base_resp: { status_code: 0 },
				model_remains: [
					makeRow({
						current_interval_remaining_percent: Number.NaN,
						current_weekly_remaining_percent: Number.NaN,
					}),
				],
			}),
		).toBeNull();
	});

	it("treats an out-of-range remaining percent as UNKNOWN, never clamping it", () => {
		// Clamping fabricated the most damaging reading available: a negative
		// remaining became 100% utilization (which can pull a HEALTHY account out
		// of routing) and >100 became 0% (which hides a spent one). Both windows
		// bogus ⇒ no evidence at all ⇒ null, not a reading of zero.
		expect(
			parseMinimaxTokenPlanResponse({
				base_resp: { status_code: 0 },
				model_remains: [
					makeRow({
						current_interval_remaining_percent: 250, // bogus
						current_weekly_remaining_percent: -10, // bogus
					}),
				],
			}),
		).toBeNull();
	});

	it("keeps the window that IS valid when only the other one is out of range", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: -10, // bogus
					current_weekly_remaining_percent: 30, // -> 70% util
				}),
			],
		});

		expect(parsed?.five_hour).toBeNull();
		expect(parsed?.seven_day?.remainingPercent).toBe(30);
		expect(parsed?.seven_day?.utilization).toBe(70);
		// The representative reading comes from the surviving window only.
		expect(getRepresentativeMinimaxUtilization(parsed)).toBe(70);
		expect(getRepresentativeMinimaxWindow(parsed)).toBe("seven_day");
	});

	it("accepts the inclusive bounds 0 and 100", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: 0, // spent
					current_weekly_remaining_percent: 100, // untouched
				}),
			],
		});

		expect(parsed?.five_hour?.utilization).toBe(100);
		expect(parsed?.seven_day?.utilization).toBe(0);
	});
});

describe("Minimax usage fetcher — representative helpers", () => {
	it("picks the more-restrictive window", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: 50, // -> 50% util
					current_weekly_remaining_percent: 80, // -> 20% util
				}),
			],
		});

		expect(getRepresentativeMinimaxUtilization(parsed)).toBe(50);
		expect(getRepresentativeMinimaxWindow(parsed)).toBe("five_hour");
	});

	it("falls back to seven_day when only the weekly window is present", () => {
		const weeklyStart = 1_700_000_000_000;
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: Number.NaN,
					start_time: Number.NaN,
					end_time: Number.NaN,
					remains_time: Number.NaN,
					weekly_start_time: weeklyStart,
					weekly_end_time: weeklyStart + SEVEN_DAY_MS,
					current_weekly_remaining_percent: 25, // -> 75% util
				}),
			],
		});

		expect(parsed?.five_hour).toBeNull();
		expect(parsed?.seven_day?.utilization).toBe(75);
		expect(getRepresentativeMinimaxUtilization(parsed)).toBe(75);
		expect(getRepresentativeMinimaxWindow(parsed)).toBe("seven_day");
	});

	it("returns null — never 0 — with no usage at all", () => {
		expect(getRepresentativeMinimaxUtilization(null)).toBeNull();
		expect(getRepresentativeMinimaxWindow(null)).toBeNull();
		expect(
			getRepresentativeMinimaxUtilization({ five_hour: null, seven_day: null }),
		).toBeNull();
		expect(
			getRepresentativeMinimaxWindow({ five_hour: null, seven_day: null }),
		).toBeNull();
	});
});

describe("Minimax usage fetcher — fetch", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("hits the documented Token Plan remains endpoint with a Bearer header", async () => {
		const body = {
			base_resp: { status_code: 0 },
			model_remains: [makeRow()],
		};
		const fetchMock = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT);
				expect(init?.method).toBe("GET");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer test-key",
				);
				return new Response(JSON.stringify(body), { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const usage = await fetchMinimaxUsageData(" test-key ");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(usage?.five_hour?.utilization).toBe(25);
	});

	it("bounds the request with an AbortSignal so a stall cannot hold the polling slot", async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				observedSignal = init?.signal ?? undefined;
				throw new DOMException("aborted", "AbortError");
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchMinimaxUsageData("k");

		expect(observedSignal).toBeInstanceOf(AbortSignal);
		expect(result).toBeNull();
	});

	it("returns null without fetching when the key is blank", async () => {
		const fetchMock = mock(async () => new Response("{}", { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		expect(await fetchMinimaxUsageData("   ")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(0);
	});

	it("returns null on non-2xx HTTP responses", async () => {
		globalThis.fetch = mock(
			async () => new Response("nope", { status: 500 }),
		) as unknown as typeof fetch;
		expect(await fetchMinimaxUsageData("k")).toBeNull();
	});

	it("returns null on a network failure", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		expect(await fetchMinimaxUsageData("k")).toBeNull();
	});
});

describe("Minimax usage fetcher — poller dispatch", () => {
	const ACCOUNT_ID = "minimax-window-roll";
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		usageCache.delete(ACCOUNT_ID);
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.stopPolling(ACCOUNT_ID);
		usageCache.delete(ACCOUNT_ID);
	});

	/** A `general` row whose interval window ends at `endMs`. */
	function rowEndingAt(endMs: number): Row {
		return makeRow({
			start_time: endMs - FIVE_HOUR_MS,
			end_time: endMs,
			remains_time: FIVE_HOUR_MS,
			weekly_start_time: endMs - SEVEN_DAY_MS,
			weekly_end_time: endMs + SEVEN_DAY_MS,
			weekly_remains_time: SEVEN_DAY_MS,
		});
	}

	it("fires the window-reset callback when the polled window rolls", async () => {
		// The dispatcher cached the fresh data without ever calling
		// notifyWindowReset, so every MiniMax rollover was invisible to the
		// window-reset bookkeeping the other providers get.
		const now = Date.now();
		// Baseline: the previous window's reset has already ARRIVED (required by
		// isGenuineWindowRoll — sub-second drift on a still-future window is not a
		// roll).
		usageCache.set(
			ACCOUNT_ID,
			parseMinimaxTokenPlanResponse({
				base_resp: { status_code: 0 },
				model_remains: [rowEndingAt(now - 1_000)],
			}) as never,
		);

		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						base_resp: { status_code: 0 },
						model_remains: [rowEndingAt(now + FIVE_HOUR_MS)],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;

		const onWindowReset = mock(() => {});
		usageCache.startPolling(
			ACCOUNT_ID,
			"api-key",
			"minimax",
			// Long interval: only the immediate fetch should run during the test.
			60 * 60 * 1000,
			null,
			onWindowReset,
		);

		const deadline = Date.now() + 5_000;
		while (onWindowReset.mock.calls.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}

		expect(onWindowReset).toHaveBeenCalledTimes(1);
		expect(onWindowReset).toHaveBeenCalledWith(ACCOUNT_ID);
		// The fresh reading still replaced the cached baseline.
		expect(
			(usageCache.peek(ACCOUNT_ID) as { five_hour?: { resetAt: number } })
				?.five_hour?.resetAt,
		).toBe(now + FIVE_HOUR_MS);
	}, 15_000);
});
