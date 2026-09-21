/**
 * The usage endpoint's retry-after is held per account id, so it outlives the
 * credentials it was imposed on. Two callers now depend on `stopPolling`
 * dropping it: the access recheck defers rather than spending a request while
 * the deadline stands, and the Anthropic reauth restarts polling so a deadline
 * from the old token cannot defer the first check of the new one.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import { usageCache } from "../usage-fetcher";

const ids: string[] = [];
function freshId(label: string): string {
	const id = `marker-${label}-${Math.floor(performance.now())}-${ids.length}`;
	ids.push(id);
	return id;
}
afterEach(() => {
	for (const id of ids.splice(0)) usageCache.stopPolling(id);
});

function rateLimitedResponse(): Response {
	return new Response(
		JSON.stringify({
			error: { type: "rate_limit_error", message: "Rate limited." },
		}),
		{ status: 429, headers: { "retry-after": "1800" } },
	);
}

it("records the usage endpoint's retry-after and drops it when polling stops", async () => {
	const id = freshId("stop");
	const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
		rateLimitedResponse(),
	);
	try {
		// `refreshNow` awaits the fetch, so the marker is observable without
		// waiting on a tick. The loop cannot race the assertions either: a
		// server retry-after governs the next poll, and this one is 30 minutes.
		usageCache.startPolling(
			id,
			async () => "token",
			"anthropic",
			600_000,
			null,
		);
		expect(await usageCache.refreshNow(id)).toBe(false);

		const until = usageCache.getRateLimitedUntil(id);
		expect(until).not.toBeNull();
		expect(until as number).toBeGreaterThan(Date.now());

		usageCache.stopPolling(id);
		expect(usageCache.getRateLimitedUntil(id)).toBeNull();
	} finally {
		fetchSpy.mockRestore();
	}
});
