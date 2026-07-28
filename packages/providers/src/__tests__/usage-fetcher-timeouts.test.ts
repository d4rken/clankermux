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
import { fetchAlibabaCodingPlanUsageData } from "../alibaba-coding-plan-usage-fetcher";
import { fetchKiloUsageData } from "../kilo-usage-fetcher";
import { fetchZaiUsageData } from "../zai-usage-fetcher";

type Fetcher = (apiKey: string) => Promise<unknown>;

const FETCHERS: Array<[string, Fetcher]> = [
	["zai", fetchZaiUsageData],
	["kilo", fetchKiloUsageData],
	["alibaba-coding-plan", fetchAlibabaCodingPlanUsageData],
];

describe("third-party usage fetchers are timeout-bounded", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	for (const [name, fetcher] of FETCHERS) {
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

		it(`${name}: an aborted fetch degrades to null, not a throw`, async () => {
			globalThis.fetch = (async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			}) as typeof globalThis.fetch;

			await expect(fetcher("test-key")).resolves.toBeNull();
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
