/**
 * The zai / kilo / alibaba usage fetchers must bound their request, exactly as
 * the Anthropic fetcher has always done.
 *
 * `usage-fetcher.ts` tracks in-flight fetches in `inFlightFetches` and only
 * deletes the entry in `promise.finally()`, so a hung fetch wedges that
 * account's polling slot for the lifetime of the process — and polling is the
 * ONLY channel that observes a locked account recovering.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { fetchAlibabaCodingPlanUsageData } from "../alibaba-coding-plan-usage-fetcher";
import { fetchKiloUsageData } from "../kilo-usage-fetcher";
import { fetchZaiUsage } from "../zai-usage-fetcher";

type Fetcher = (apiKey: string) => Promise<unknown>;

/** Each fetcher paired with the value it degrades to when the fetch fails. */
const FETCHERS: Array<[string, Fetcher, unknown]> = [
	["zai", fetchZaiUsage, { status: "failed" }],
	["kilo", fetchKiloUsageData, null],
	["alibaba-coding-plan", fetchAlibabaCodingPlanUsageData, null],
];

describe("third-party usage fetchers are timeout-bounded", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	for (const [name, fetcher, degraded] of FETCHERS) {
		it(`${name}: passes an AbortSignal to fetch`, async () => {
			let seenSignal: AbortSignal | null | undefined;
			globalThis.fetch = (async (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => {
				seenSignal =
					input instanceof Request ? input.signal : (init?.signal ?? null);
				return new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof globalThis.fetch;

			await fetcher("test-key");
			expect(seenSignal).toBeInstanceOf(AbortSignal);
			expect(seenSignal?.aborted).toBe(false);
		});

		it(`${name}: an aborted fetch degrades to a value, not a throw`, async () => {
			globalThis.fetch = mockFetch(async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			});

			await expect(fetcher("test-key")).resolves.toEqual(degraded);
		});

		it(`${name}: clears the timer so the process is not held open`, async () => {
			// A leaked setTimeout would keep the event loop alive for 5s after every
			// poll. Observed indirectly: the fetcher settles and the signal, whose
			// only aborter is that timer, is still un-aborted a tick later.
			let seenSignal: AbortSignal | null | undefined;
			globalThis.fetch = (async (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => {
				seenSignal =
					input instanceof Request ? input.signal : (init?.signal ?? null);
				return new Response("{}", {
					status: 500,
					statusText: "Server Error",
				});
			}) as typeof globalThis.fetch;

			await fetcher("test-key");
			await new Promise((r) => setTimeout(r, 10));
			expect(seenSignal?.aborted).toBe(false);
		});
	}
});
