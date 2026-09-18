import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import { type AnthropicUsageObservation, usageCache } from "../usage-fetcher";

const ACCOUNT = "anthropic-usage-observation";
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	usageCache.stopPolling(ACCOUNT);
	fetchSpy?.mockRestore();
});

function response(denied = false): Response {
	return Response.json(
		denied
			? { error: { type: "permission_error", message: "denied" } }
			: {
					five_hour: {
						utilization: 10,
						resets_at: new Date(Date.now() + 3_600_000).toISOString(),
					},
				},
		{ status: denied ? 403 : 200 },
	);
}
function start(
	observer: (event: AnthropicUsageObservation) => Promise<void>,
	token = "token",
) {
	usageCache.startPolling(
		ACCOUNT,
		token,
		"anthropic",
		3_600_000,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ initialDelayMs: 3_600_000, onAnthropicUsageObservation: observer },
		undefined,
	);
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++)
		await new Promise((resolve) => setTimeout(resolve, 1));
	expect(predicate()).toBe(true);
}

describe("Anthropic usage observation", () => {
	it("refreshNow returns usage promptly while the diagnosis can be awaited separately", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async () => response(true)),
		);
		const events: AnthropicUsageObservation[] = [];
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		start(async (event) => {
			events.push(event);
			await hold;
		});
		let settled = false;
		const pending = usageCache.refreshNow(ACCOUNT).then((result) => {
			settled = true;
			return result;
		});
		await until(() => events.length === 1);
		expect(settled).toBe(true);
		expect(events[0]?.accessToken).toBe("token");
		expect(events[0]?.firstPermissionDenial).toBe(true);
		let diagnosisSettled = false;
		const diagnosis = usageCache
			.waitForAnthropicUsageObservation(ACCOUNT)
			.then(() => {
				diagnosisSettled = true;
			});
		await Promise.resolve();
		expect(diagnosisSettled).toBe(false);
		release();
		await diagnosis;
		expect(await pending).toBe(false);
		await usageCache.refreshNow(ACCOUNT);
		expect(events[1]?.firstPermissionDenial).toBe(false);
	});
	it("replacement invalidates a pending diagnosis even when the token is unchanged", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async () => response(true)),
		);
		let event: AnthropicUsageObservation | undefined;
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		start(async (observation) => {
			event = observation;
			await hold;
		});
		const old = usageCache.refreshNow(ACCOUNT);
		await until(() => event != null);
		expect(event?.isCurrent()).toBe(true);
		start(async () => {});
		expect(event?.isCurrent()).toBe(false);
		const replacementWait = await Promise.race([
			usageCache.waitForAnthropicUsageObservation(ACCOUNT).then(() => "ready"),
			new Promise<string>((resolve) => setTimeout(() => resolve("stale"), 50)),
		]);
		release();
		expect(replacementWait).toBe("ready");
		await old;
		expect(usageCache.get(ACCOUNT)).toBeNull();
	});
	it("contains diagnosis failures without discarding successful usage", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async () => response()),
		);
		start(async () => {
			throw new Error("DB unavailable");
		});
		expect(await usageCache.refreshNow(ACCOUNT)).toBe(true);
		expect(usageCache.get(ACCOUNT)).not.toBeNull();
	});
	it("reports unavailable usage on 429 so profile diagnosis can proceed independently", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(
				async () =>
					new Response("rate limited", {
						status: 429,
						headers: { "retry-after": "120" },
					}),
			),
		);
		const events: AnthropicUsageObservation[] = [];
		start(async (event) => {
			events.push(event);
		});
		expect(await usageCache.refreshNow(ACCOUNT)).toBe(false);
		await usageCache.waitForAnthropicUsageObservation(ACCOUNT);
		expect(
			events.map((event) => [event.outcome, event.firstPermissionDenial]),
		).toEqual([["unavailable", false]]);
		expect(usageCache.get(ACCOUNT)).toBeNull();
		expect(events[0]?.isCurrent()).toBe(true);
	});
	it("marks recovery then subsequent denial as a fresh diagnosis", async () => {
		let denied = true;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async () => response(denied)),
		);
		const events: AnthropicUsageObservation[] = [];
		start(async (event) => {
			events.push(event);
		});
		await usageCache.refreshNow(ACCOUNT);
		denied = false;
		await usageCache.refreshNow(ACCOUNT);
		denied = true;
		await usageCache.refreshNow(ACCOUNT);
		expect(
			events.map((event) => [event.outcome, event.firstPermissionDenial]),
		).toEqual([
			["permission_denied", true],
			["success", false],
			["permission_denied", true],
		]);
	});
});
