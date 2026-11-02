/**
 * The header store on UsageCache: 5h/7d readings from proxied responses,
 * bound to the poll generation that was live when the request went out, and
 * the two freshness lookups built on it.
 *
 * Pollers are started with a far-off first fetch, so nothing is sent; the
 * store's lifecycle only needs a registered poller.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ExtractedClaimReading } from "@clankermux/core";
import {
	getFreshPollCapacity,
	getFreshRoutingCapacity,
	getFreshRoutingUsage,
	USAGE_CACHE_TTL_MS,
	type UsageData,
	usageCache,
} from "../usage-fetcher";
import { isUsageViewFresh } from "../usage-header-view";

const HOUR = 3_600_000;
const FIVE_RESET_S = () => Math.floor((Date.now() + 2 * HOUR) / 1000);
const WEEK_RESET_S = () => Math.floor((Date.now() + 90 * HOUR) / 1000);

let counter = 0;
const cleanups: string[] = [];
function freshId(label: string): string {
	const id = `hdr-${label}-${Date.now()}-${counter++}`;
	cleanups.push(id);
	return id;
}

afterEach(() => {
	for (const id of cleanups.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
});

function register(id: string): void {
	usageCache.startPolling(
		id,
		async () => "token",
		"anthropic",
		90_000,
		null,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{ initialDelayMs: 10 * HOUR },
	);
}

function pollReading(fivePct: number, weekPct: number): UsageData {
	return {
		five_hour: {
			utilization: fivePct,
			resets_at: new Date(FIVE_RESET_S() * 1000 + 219).toISOString(),
		},
		seven_day: {
			utilization: weekPct,
			resets_at: new Date(WEEK_RESET_S() * 1000 + 431).toISOString(),
		},
	};
}

function claims(fiveFraction: number, weekFraction = 0.3) {
	return [
		{
			claim: "5h",
			status: "allowed",
			utilization: fiveFraction,
			resetMs: FIVE_RESET_S() * 1000,
			surpassedThreshold: null,
		},
		{
			claim: "7d",
			status: "allowed",
			utilization: weekFraction,
			resetMs: WEEK_RESET_S() * 1000,
			surpassedThreshold: null,
		},
	] satisfies ExtractedClaimReading[];
}

function fiveHourOf(id: string, provider = "anthropic"): number | undefined {
	const view = usageCache.peekUsageView(id, provider, Date.now());
	return (view?.data as UsageData | undefined)?.five_hour?.utilization;
}

describe("UsageCache header store — recording", () => {
	it("records a response's 5h/7d readings for a live poller", () => {
		const id = freshId("record");
		register(id);
		usageCache.set(id, pollReading(40, 30));
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			Date.now(),
		);
		expect(fiveHourOf(id)).toBe(50);
	});

	it("has no epoch, and records nothing, without a live poller", () => {
		const id = freshId("no-poller");
		usageCache.set(id, pollReading(40, 30));
		expect(usageCache.usageHeaderEpoch(id)).toBeNull();
		usageCache.recordUsageHeaders(id, null, claims(0.5), Date.now());
		expect(fiveHourOf(id)).toBe(40);
	});

	it("drops a response that started before stopPolling", () => {
		const id = freshId("stop");
		register(id);
		const epoch = usageCache.usageHeaderEpoch(id);
		usageCache.stopPolling(id);
		usageCache.recordUsageHeaders(id, epoch, claims(0.9), Date.now());
		register(id);
		usageCache.set(id, pollReading(40, 30));
		expect(fiveHourOf(id)).toBe(40);
	});

	it("drops a response that started before a poller restart", () => {
		const id = freshId("restart");
		register(id);
		const epoch = usageCache.usageHeaderEpoch(id);
		register(id); // replaced without stopPolling (re-auth)
		usageCache.set(id, pollReading(40, 30));
		usageCache.recordUsageHeaders(id, epoch, claims(0.9), Date.now());
		expect(fiveHourOf(id)).toBe(40);
	});

	it("never matches an epoch across deletion and reuse of the account id", () => {
		const id = freshId("reuse");
		register(id);
		const first = usageCache.usageHeaderEpoch(id);
		usageCache.stopPolling(id);
		usageCache.delete(id);
		register(id);
		expect(usageCache.usageHeaderEpoch(id)).not.toBe(first);
		usageCache.set(id, pollReading(40, 30));
		usageCache.recordUsageHeaders(id, first, claims(0.9), Date.now());
		expect(fiveHourOf(id)).toBe(40);
	});

	it("delete() clears stored readings and fences in-flight responses", () => {
		const id = freshId("delete");
		register(id);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.9),
			Date.now(),
		);
		const inFlight = usageCache.usageHeaderEpoch(id);
		usageCache.delete(id);
		usageCache.recordUsageHeaders(id, inFlight, claims(0.95), Date.now());
		usageCache.set(id, pollReading(40, 30));
		expect(fiveHourOf(id)).toBe(40);
	});

	it("fenceAndRefetch clears stored readings and fences in-flight responses", async () => {
		const id = freshId("fence");
		register(id);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.9),
			Date.now(),
		);
		const inFlight = usageCache.usageHeaderEpoch(id);
		const refetch = usageCache.fenceAndRefetch(id);
		usageCache.recordUsageHeaders(id, inFlight, claims(0.95), Date.now());
		usageCache.set(id, pollReading(40, 30));
		expect(fiveHourOf(id)).toBe(40);
		usageCache.stopPolling(id);
		await refetch;
	});

	it("keeps the later-observed reading when responses land out of order", () => {
		const id = freshId("order");
		register(id);
		usageCache.set(id, pollReading(10, 30));
		const epoch = usageCache.usageHeaderEpoch(id);
		const now = Date.now();
		usageCache.recordUsageHeaders(id, epoch, claims(0.6), now);
		usageCache.recordUsageHeaders(id, epoch, claims(0.55), now - 1_000);
		expect(fiveHourOf(id)).toBe(60);
	});

	it("ignores rejected, malformed and out-of-range claims", () => {
		const id = freshId("invalid");
		register(id);
		usageCache.set(id, pollReading(40, 30));
		const epoch = usageCache.usageHeaderEpoch(id);
		const bad = (overrides: Partial<ExtractedClaimReading>) => [
			{ ...claims(0.9)[0], ...overrides },
		];
		usageCache.recordUsageHeaders(
			id,
			epoch,
			bad({ status: "rejected" }),
			Date.now(),
		);
		usageCache.recordUsageHeaders(
			id,
			epoch,
			bad({ utilization: null }),
			Date.now(),
		);
		usageCache.recordUsageHeaders(
			id,
			epoch,
			bad({ utilization: 1.5 }),
			Date.now(),
		);
		usageCache.recordUsageHeaders(
			id,
			epoch,
			bad({ resetMs: Date.now() - 1 }),
			Date.now(),
		);
		expect(fiveHourOf(id)).toBe(40);
	});
});

describe("UsageCache header store — lookups", () => {
	it("the poll-only lookup never sees header readings", () => {
		const id = freshId("poll-only");
		register(id);
		usageCache.setWithAgeForTests(id, pollReading(40, 30), 500_000);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			Date.now(),
		);
		const now = Date.now();
		expect(
			getFreshPollCapacity(usageCache, id, "anthropic", now, 180_000),
		).toBeNull();
		expect(
			getFreshRoutingCapacity(usageCache, id, "anthropic", now, 180_000)
				?.sessionHeadroom,
		).toBe(50);
	});

	it("an 11-minute-old poll base still carries 60 s-old headers", () => {
		const id = freshId("base");
		register(id);
		const elevenMinutes = USAGE_CACHE_TTL_MS + 60_000;
		usageCache.setWithAgeForTests(id, pollReading(40, 30), elevenMinutes);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			Date.now() - 60_000,
		);
		const now = Date.now();
		expect(
			(
				getFreshRoutingUsage(
					usageCache,
					id,
					"anthropic",
					now,
					180_000,
				) as UsageData | null
			)?.five_hour?.utilization,
		).toBe(50);

		// A reported poll-only axis still needs the poll inside the bound.
		usageCache.setWithAgeForTests(
			id,
			{
				...pollReading(40, 30),
				seven_day_oauth_apps: { utilization: 10, resets_at: null },
			},
			elevenMinutes,
		);
		expect(
			getFreshRoutingUsage(usageCache, id, "anthropic", now, 180_000),
		).toBeNull();
	});

	it("neither lookup evicts a stale poll entry, so the next poll keeps its baseline", () => {
		const id = freshId("no-evict");
		register(id);
		const oldReset = Date.now() - 1_000;
		usageCache.setWithAgeForTests(
			id,
			{
				five_hour: {
					utilization: 90,
					resets_at: new Date(oldReset).toISOString(),
				},
				seven_day: pollReading(40, 30).seven_day,
			},
			USAGE_CACHE_TTL_MS + 60_000,
		);
		const now = Date.now();
		getFreshPollCapacity(usageCache, id, "anthropic", now, 180_000);
		getFreshRoutingCapacity(usageCache, id, "anthropic", now, 180_000);
		expect(usageCache.peekAge(id)).not.toBeNull();

		// The window-roll comparison a poll makes before writing still sees it.
		let rolled = 0;
		usageCache.notifyWindowReset(id, pollReading(5, 30), "anthropic", () => {
			rolled++;
		});
		expect(rolled).toBe(1);
	});

	it("a non-Anthropic provider reads the poll alone", () => {
		const id = freshId("codex");
		register(id);
		usageCache.set(id, pollReading(40, 30));
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			Date.now(),
		);
		expect(fiveHourOf(id, "codex")).toBe(40);
	});

	it("clear() drops every header reading", () => {
		const id = freshId("clear");
		register(id);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			Date.now(),
		);
		usageCache.clear();
		register(id);
		usageCache.set(id, pollReading(40, 30));
		expect(fiveHourOf(id)).toBe(40);
	});
});

describe("UsageCache header store — 5h claim shape", () => {
	const weeklyOnly = () => [claims(0.5)[1]];
	const fiveHourAxis = (id: string) =>
		usageCache.peekUsageView(id, "anthropic", Date.now())?.fiveHour;
	const fiveHourKey = (id: string, horizonMs?: number) => {
		const data = usageCache.peekUsageView(
			id,
			"anthropic",
			Date.now(),
			horizonMs,
		)?.data as UsageData | undefined;
		return data && "five_hour" in data ? data.five_hour : "missing";
	};

	it("records an absence that came with no usable reading", () => {
		const id = freshId("shape-only");
		register(id);
		usageCache.set(id, pollReading(40, 30));
		const observedAt = Date.now() + 1;
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			[],
			observedAt,
			"absent",
		);
		expect(fiveHourKey(id)).toBeNull();
		expect(fiveHourAxis(id)).toEqual({
			source: "header",
			observedAtMs: observedAt,
			freshAtMs: observedAt,
		});
	});

	it("records nothing for an unknown shape with no usable reading", () => {
		const id = freshId("shape-unknown");
		register(id);
		usageCache.set(id, pollReading(40, 30));
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			[],
			Date.now() + 1,
			"unknown",
		);
		expect(fiveHourOf(id)).toBe(40);
		expect(fiveHourAxis(id)?.source).toBe("poll");
	});

	it("ages the shape out with the view's horizon", () => {
		const id = freshId("shape-horizon");
		register(id);
		// A poll that names no 5h window either way, so only the header decides.
		usageCache.set(id, {
			seven_day: pollReading(40, 30).seven_day,
		} as unknown as UsageData);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			weeklyOnly(),
			Date.now() - 10 * 60_000,
			"absent",
		);
		expect(fiveHourKey(id, 15 * 60_000)).toBeNull();
		expect(fiveHourKey(id, 5 * 60_000)).toBe("missing");
	});

	it("rejects a late reading observed before a recorded absence", () => {
		const id = freshId("shape-late");
		register(id);
		usageCache.set(id, pollReading(40, 30));
		const epoch = usageCache.usageHeaderEpoch(id);
		const now = Date.now() + 1;
		usageCache.recordUsageHeaders(id, epoch, weeklyOnly(), now, "absent");
		usageCache.recordUsageHeaders(
			id,
			epoch,
			claims(0.5),
			now - 1_000,
			"present",
		);
		expect(fiveHourKey(id)).toBeNull();
	});

	it("delete() clears the shape and its absence watermark", () => {
		const id = freshId("shape-delete");
		register(id);
		const now = Date.now();
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			weeklyOnly(),
			now,
			"absent",
		);
		usageCache.delete(id);
		usageCache.set(id, pollReading(40, 30));
		// Observed before the deleted absence, so the watermark would refuse it.
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			now - 1_000,
			"present",
		);
		expect(fiveHourOf(id)).toBe(50);
	});
});

describe("UsageCache header store — a poll's 5h absence", () => {
	const ultraPoll = (): UsageData =>
		({
			five_hour: null,
			seven_day: pollReading(40, 30).seven_day,
		}) as unknown as UsageData;
	const noFiveHourKey = (): UsageData =>
		({ seven_day: pollReading(40, 30).seven_day }) as unknown as UsageData;
	const fiveHourKey = (id: string) => {
		const data = usageCache.peekUsageView(id, "anthropic", Date.now())?.data as
			| UsageData
			| undefined;
		return data && "five_hour" in data ? data.five_hour : "missing";
	};

	it("drops a 5h header reading observed before the poll said the window is gone", () => {
		const id = freshId("poll-absent");
		register(id);
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			claims(0.5),
			Date.now() - 1_000,
			"present",
		);
		usageCache.set(id, ultraPoll());
		usageCache.set(id, noFiveHourKey());
		expect(fiveHourKey(id)).toBeNull();
		expect(fiveHourOf(id)).toBeUndefined();
	});

	it("a malformed 5h presence after a poll's absence leaves no fresh 5h axis", () => {
		const id = freshId("poll-absent-malformed");
		register(id);
		usageCache.set(id, ultraPoll());
		// A lone `5h-utilization` line: presence, no usable reading.
		usageCache.recordUsageHeaders(
			id,
			usageCache.usageHeaderEpoch(id),
			[{ ...claims(0.5)[0], status: "", resetMs: null }],
			Date.now() + 1,
			"present",
		);
		usageCache.set(id, noFiveHourKey());
		const now = Date.now() + 2;
		const view = usageCache.peekUsageView(id, "anthropic", now);
		expect(view).not.toBeNull();
		expect(view && isUsageViewFresh(view, now, 180_000)).toBe(false);
	});

	it.each([
		[
			"a stopped poller",
			(id: string) => {
				register(id);
				usageCache.stopPolling(id);
				return id;
			},
		],
		[
			"a non-Anthropic poller",
			(id: string) => {
				usageCache.startPolling(
					id,
					async () => "token",
					"zai",
					90_000,
					null,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{ initialDelayMs: 10 * HOUR },
				);
				return id;
			},
		],
	] as const)("records no header absence for %s", (_label, setUp) => {
		const id = setUp(freshId("poll-absent-unbound"));
		usageCache.set(id, ultraPoll());
		usageCache.set(id, noFiveHourKey());
		expect(fiveHourKey(id)).toBe("missing");
	});
});
