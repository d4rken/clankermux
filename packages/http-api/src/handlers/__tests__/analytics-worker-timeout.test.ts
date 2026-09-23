/**
 * Dashboard worker LANES and their timeout semantics.
 *
 * bun:sqlite calls are synchronous, so one worker serves requests strictly one
 * at a time. A single shared worker therefore head-of-line blocked every light
 * dashboard panel behind an all-time analytics read (measured on the live
 * server: analytics 46.2 s / 200, stats issued 1 s later 15.0 s / 503 — and the
 * Overview then rendered `?? 0` with no error shown).
 *
 * This suite was deliberately REWRITTEN from the previous single-worker one,
 * which asserted `created === 1` for an analytics + stats pair. That assertion
 * is now exactly wrong: those two kinds must land in DIFFERENT workers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { APIContext } from "../../types";
import {
	__setDashboardWorkerFactoryForTests,
	__setDashboardWorkerTimeoutsForTests,
	clearAnalyticsCachesForTests,
	createIsolatedAnalyticsHandler,
	createIsolatedStatsHandler,
	createIsolatedUsageHistoryHandler,
	type DashboardWorkerLike,
	getAnalyticsCacheStatsForTests,
	getWorkerTimeoutMs,
	invalidateDashboardCache,
	terminateAnalyticsWorker,
} from "../analytics-runner";
import type {
	AnalyticsWorkerRequest,
	AnalyticsWorkerResponse,
	DashboardWorkerKind,
} from "../analytics-worker";

// The isolated dashboard handlers only take the worker path when a db path is
// present; the stub worker never actually opens it, so any non-empty string is
// fine. getAdapter is stubbed for the (unused) direct-handler fallback.
const fakeContext = {
	db: {},
	config: {},
	dbOps: {
		getResolvedDbPath: () => "/tmp/clankermux-timeout-test.db",
		getAdapter: () => ({}),
	},
} as unknown as APIContext;

/**
 * Controllable dashboard worker. `shouldReply` decides per message whether to
 * answer (after `replyDelayMs`) or hang forever, standing in for a query that
 * runs past its deadline.
 */
class FakeDashboardWorker implements DashboardWorkerLike {
	posted: AnalyticsWorkerRequest[] = [];
	terminateCount = 0;
	onmessage: ((event: MessageEvent<AnalyticsWorkerResponse>) => void) | null =
		null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessageerror: (() => void) | null = null;

	constructor(
		private readonly opts: {
			shouldReply: (message: AnalyticsWorkerRequest) => boolean;
			replyDelayMs?: number;
		},
	) {}

	postMessage(message: AnalyticsWorkerRequest): void {
		this.posted.push(message);
		if (!this.opts.shouldReply(message)) return; // simulate a hang
		setTimeout(() => {
			this.reply(message.id);
		}, this.opts.replyDelayMs ?? 5);
	}

	/** Post a result for an arbitrary id — used to simulate a LATE message. */
	reply(id: string, body: unknown = { ok: true }): void {
		this.onmessage?.({
			data: {
				id,
				ok: true,
				status: 200,
				body: JSON.stringify(body),
			},
		} as MessageEvent<AnalyticsWorkerResponse>);
	}

	terminate(): void {
		this.terminateCount++;
	}

	unref(): void {}
}

/** Reply to everything except the given kinds. */
function repliesExcept(...hang: DashboardWorkerKind[]) {
	const hanging = new Set(hang);
	return (message: AnalyticsWorkerRequest) =>
		!hanging.has(message.kind ?? "analytics");
}

/** Collect every worker the runner creates, in creation order. */
function trackWorkers(make: () => FakeDashboardWorker): FakeDashboardWorker[] {
	const created: FakeDashboardWorker[] = [];
	__setDashboardWorkerFactoryForTests(() => {
		const worker = make();
		created.push(worker);
		return worker;
	});
	return created;
}

afterEach(() => {
	__setDashboardWorkerFactoryForTests(null);
	__setDashboardWorkerTimeoutsForTests(null);
	terminateAnalyticsWorker();
	clearAnalyticsCachesForTests();
});

describe("dashboard worker per-kind timeouts", () => {
	it("gives analytics a longer soft deadline than the light kinds", () => {
		expect(getWorkerTimeoutMs("analytics")).toBe(60_000);
		for (const kind of [
			"stats",
			"usage-history",
			"usage-scoped-history",
			"memory-history",
			"cache-keepalive-history",
			"cache-effectiveness",
			"payments-summary",
			"filter-options",
			"quota-drift",
			"pool-sizing",
		] as const) {
			expect(getWorkerTimeoutMs(kind)).toBe(15_000);
			expect(getWorkerTimeoutMs("analytics")).toBeGreaterThan(
				getWorkerTimeoutMs(kind),
			);
		}
	});
});

describe("worker lanes", () => {
	it("completes a light-lane request while the heavy lane is blocked", async () => {
		const created = trackWorkers(
			() =>
				new FakeDashboardWorker({ shouldReply: repliesExcept("analytics") }),
		);
		// A soft deadline the hung analytics read will blow through; the light
		// read must not wait for it at all.
		__setDashboardWorkerTimeoutsForTests({ soft: 60, hard: 5_000 });

		const analyticsPromise = createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all" }),
		);
		const startedAt = Date.now();
		const statsRes = await createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h" }),
		);
		const statsElapsed = Date.now() - startedAt;

		expect(statsRes.status).toBe(200);
		// The point of the split: the light read finished long before the heavy
		// one even reached its soft deadline.
		expect(statsElapsed).toBeLessThan(60);
		expect((await analyticsPromise).status).toBe(503);

		// One worker PER LANE — not one shared worker, which is what made the
		// light read wait in the first place.
		expect(created).toHaveLength(2);
		expect(created[0].terminateCount).toBe(0);
		expect(created[1].terminateCount).toBe(0);
	});

	it("reuses one worker per lane across requests", async () => {
		const created = trackWorkers(
			() => new FakeDashboardWorker({ shouldReply: () => true }),
		);
		__setDashboardWorkerTimeoutsForTests({ soft: 500, hard: 5_000 });

		// Distinct params defeat the response cache, so each is a real round-trip.
		await createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h", n: "1" }),
		);
		await createIsolatedUsageHistoryHandler(fakeContext)(
			new URLSearchParams({ range: "7d", n: "2" }),
		);
		await createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h", n: "3" }),
		);
		expect(created).toHaveLength(1); // all three are light-lane

		await createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "24h", n: "4" }),
		);
		await createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "24h", n: "5" }),
		);
		expect(created).toHaveLength(2); // one more, for the heavy lane
	});

	it("light-lane traffic does not keep a wedged heavy worker alive", async () => {
		const created = trackWorkers(() => {
			// Burn the rest of the current millisecond, so the lane's activity
			// clock — stamped after construction returns — is strictly later than
			// the instant the watchdog timers were armed. A real Worker always
			// takes that long to spawn; this fake does not, and without the gap
			// the wedge this case asserts on is not the one production sees.
			const startedAt = Date.now();
			while (Date.now() === startedAt) {}
			return new FakeDashboardWorker({
				shouldReply: repliesExcept("analytics"),
				replyDelayMs: 2,
			});
		});
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 60 });

		const analyticsPromise = createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all" }),
		);

		// Keep the LIGHT worker demonstrably busy across the heavy lane's hard
		// deadline. Under the old shared-worker design those replies refreshed the
		// single activity clock and the wedged analytics query was never detected.
		const start = Date.now();
		while (Date.now() - start < 100) {
			await createIsolatedStatsHandler(fakeContext)(
				new URLSearchParams({ range: "24h", n: String(Date.now()) }),
			);
		}

		expect((await analyticsPromise).status).toBe(503);
		const [heavy, light] = created;
		expect(heavy.terminateCount).toBe(1); // wedged heavy worker torn down
		expect(light.terminateCount).toBe(0); // healthy light worker untouched
	});

	it("a heavy worker failure rejects only heavy state; a light request outstanding at that moment still completes", async () => {
		// Uses onerror rather than the hard watchdog to trigger the heavy reset:
		// the test seam sets ONE hard deadline for every lane, so a light request
		// timed to still be in flight when the heavy watchdog fires would be
		// retired by its own watchdog in the same tick. onerror isolates the
		// question actually under test — does a heavy teardown touch light state?
		// (The heavy hard-timeout's isolation is covered by the wedged-worker case
		// above, which asserts the light worker is never terminated.)
		const created = trackWorkers(
			() =>
				new FakeDashboardWorker({
					shouldReply: repliesExcept("analytics"),
					replyDelayMs: 60,
				}),
		);
		__setDashboardWorkerTimeoutsForTests({ soft: 2_000, hard: 10_000 });

		const analyticsPromise = createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all" }),
		);
		const statsPromise = createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h" }),
		);
		// Both have reached their workers; the light reply is still ~40ms out.
		await Bun.sleep(20);

		const [heavy, light] = created;
		expect(light.posted).toHaveLength(1);
		heavy.onerror?.({ message: "heavy worker exploded" } as ErrorEvent);

		// The heavy read fails (500 — a worker error, not a timeout)...
		expect((await analyticsPromise).status).toBe(500);
		// ...and the light request, outstanding across that reset, still resolves.
		expect((await statsPromise).status).toBe(200);
		expect(heavy.terminateCount).toBe(1);
		expect(light.terminateCount).toBe(0);
	});

	it("terminateAnalyticsWorker() tears down BOTH lane instances", async () => {
		const created = trackWorkers(
			() => new FakeDashboardWorker({ shouldReply: () => true }),
		);
		__setDashboardWorkerTimeoutsForTests({ soft: 500, hard: 5_000 });

		await createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "24h" }),
		);
		await createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h" }),
		);
		expect(created).toHaveLength(2);

		terminateAnalyticsWorker();
		expect(created[0].terminateCount).toBe(1);
		expect(created[1].terminateCount).toBe(1);
	});

	it("a late message from a REPLACED worker neither refreshes nor resets its successor", async () => {
		const created = trackWorkers(
			() =>
				new FakeDashboardWorker({ shouldReply: repliesExcept("analytics") }),
		);
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 50 });

		// Wedge the first heavy worker so the hard watchdog replaces it.
		const first = await createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all", n: "1" }),
		);
		expect(first.status).toBe(503);
		await Bun.sleep(80);
		const wedged = created[0];
		expect(wedged.terminateCount).toBe(1);

		// A replacement heavy worker takes over; keep it hung too so its own hard
		// watchdog is the thing under test.
		const secondPromise = createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all", n: "2" }),
		);
		await Bun.sleep(5);
		const successor = created[1];
		expect(successor).not.toBe(wedged);

		// The retired worker posts late — for its OWN request and for an unrelated
		// id. Neither may touch the successor: refreshing its activity clock would
		// hide a genuine wedge, and an error from it would kill healthy work.
		wedged.reply(wedged.posted[0].id);
		wedged.reply("some-other-id");
		wedged.onerror?.({ message: "late failure" } as ErrorEvent);

		expect(successor.terminateCount).toBe(0);
		expect((await secondPromise).status).toBe(503);

		// The successor's own wedge is still detected on schedule.
		await Bun.sleep(80);
		expect(successor.terminateCount).toBe(1);
	});
});

describe("one worker job per request key", () => {
	// The soft deadline answers a caller; it must not end the job. On
	// 2026-09-23 a 7-day analytics read outlived its caller, the next tab
	// refresh posted the same read again behind it, and one waited 49s in the
	// heavy queue before it even started.
	const analytics = (params: Record<string, string>) =>
		createIsolatedAnalyticsHandler(fakeContext)(new URLSearchParams(params));
	const HUNG = { range: "7d", hang: "1" };

	/** Hang every message that carries `hang`; answer the rest after 2ms. */
	function hangTagged() {
		return trackWorkers(
			() =>
				new FakeDashboardWorker({
					shouldReply: (message) =>
						!new URLSearchParams(message.params).has("hang"),
					replyDelayMs: 2,
				}),
		);
	}

	it("keeps the job running past a caller's soft deadline and lets the next caller join it", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 30, hard: 5_000 });

		expect((await analytics(HUNG)).status).toBe(503);
		const second = analytics(HUNG);
		await Bun.sleep(5);
		const [heavy] = created;
		expect(heavy.posted).toHaveLength(1);

		heavy.reply(heavy.posted[0].id, { answer: 42 });
		const response = await second;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ answer: 42 });
	});

	it("caches a result that arrives after every caller gave up", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		expect((await analytics(HUNG)).status).toBe(503);
		const [heavy] = created;
		heavy.reply(heavy.posted[0].id, { answer: "late" });
		await Bun.sleep(5);

		const response = await analytics(HUNG);
		expect(response.status).toBe(200);
		expect(response.headers.get("X-ClankerMux-Analytics-Mode")).toBe(
			"worker-cache",
		);
		expect(await response.json()).toEqual({ answer: "late" });
		expect(heavy.posted).toHaveLength(1);
	});

	it("gives two callers of one job independent bodies", async () => {
		const created = trackWorkers(
			() =>
				new FakeDashboardWorker({ shouldReply: () => true, replyDelayMs: 20 }),
		);
		__setDashboardWorkerTimeoutsForTests({ soft: 500, hard: 5_000 });

		const [a, b] = await Promise.all([
			analytics({ range: "7d" }),
			analytics({ range: "7d" }),
		]);
		expect(await a.json()).toEqual({ ok: true });
		expect(await b.json()).toEqual({ ok: true });
		expect(created[0].posted).toHaveLength(1);
	});

	it("orphans a running job on invalidation and never caches its result", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		expect((await analytics(HUNG)).status).toBe(503);
		invalidateDashboardCache("analytics");
		const fresh = analytics(HUNG);
		await Bun.sleep(5);
		const [heavy] = created;
		expect(heavy.posted).toHaveLength(2);

		heavy.reply(heavy.posted[0].id, { stale: true });
		await Bun.sleep(5);
		expect(getAnalyticsCacheStatsForTests().responseCacheSize).toBe(0);

		heavy.reply(heavy.posted[1].id, { stale: false });
		expect(await (await fresh).json()).toEqual({ stale: false });
	});

	it("honours an invalidation that lands while the result is being cached", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		expect((await analytics(HUNG)).status).toBe(503);
		const [heavy] = created;
		heavy.reply(heavy.posted[0].id);
		// Queued behind the job's own continuation, so it lands after the
		// result reached the cache writer and before the write.
		queueMicrotask(() => invalidateDashboardCache("analytics"));
		await Bun.sleep(5);

		expect(getAnalyticsCacheStatsForTests().responseCacheSize).toBe(0);
	});

	it("keeps a cleared job's late result out of the cache and starts afresh", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		expect((await analytics(HUNG)).status).toBe(503);
		clearAnalyticsCachesForTests();
		const [heavy] = created;
		heavy.reply(heavy.posted[0].id);
		await Bun.sleep(5);
		expect(getAnalyticsCacheStatsForTests()).toEqual({
			responseCacheSize: 0,
			inFlightSize: 0,
		});

		const again = analytics(HUNG);
		await Bun.sleep(5);
		expect(heavy.posted).toHaveLength(2);
		heavy.reply(heavy.posted[1].id);
		expect((await again).status).toBe(200);
	});

	it("rejects every queued job once on a lane reset, so each key starts fresh", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		// Key one has lost its caller; key two still has one waiting.
		expect((await analytics({ ...HUNG, n: "1" })).status).toBe(503);
		__setDashboardWorkerTimeoutsForTests({ soft: 2_000, hard: 5_000 });
		const waiting = analytics({ ...HUNG, n: "2" });
		await Bun.sleep(5);
		const [heavy] = created;
		expect(heavy.posted).toHaveLength(2);

		heavy.onerror?.({ message: "heavy worker exploded" } as ErrorEvent);
		expect((await waiting).status).toBe(500);
		await Bun.sleep(1);
		expect(getAnalyticsCacheStatsForTests().inFlightSize).toBe(0);

		const retries = [
			analytics({ ...HUNG, n: "1" }),
			analytics({ ...HUNG, n: "2" }),
		];
		await Bun.sleep(5);
		const successor = created[1];
		expect(successor).not.toBe(heavy);
		expect(successor.posted).toHaveLength(2);
		for (const message of successor.posted) successor.reply(message.id);
		for (const retry of retries) expect((await retry).status).toBe(200);
	});

	it("drops a job whose worker fails after every caller left, without an unhandled rejection", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		expect((await analytics(HUNG)).status).toBe(503);
		created[0].onerror?.({ message: "late failure" } as ErrorEvent);
		await Bun.sleep(5);
		expect(getAnalyticsCacheStatsForTests()).toEqual({
			responseCacheSize: 0,
			inFlightSize: 0,
		});
	});

	it("keeps a job past its hard deadline while its worker keeps answering others", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 60 });

		expect((await analytics(HUNG)).status).toBe(503);
		// Other heavy reads keep the lane demonstrably alive past the hard
		// deadline of the hung one.
		const start = Date.now();
		while (Date.now() - start < 150) {
			const other = await analytics({ range: "24h", n: String(Date.now()) });
			expect(other.status).toBe(200);
		}
		const [heavy] = created;
		expect(heavy.terminateCount).toBe(0);

		const joined = analytics(HUNG);
		await Bun.sleep(5);
		const hungPosts = heavy.posted.filter((message) =>
			new URLSearchParams(message.params).has("hang"),
		);
		expect(hungPosts).toHaveLength(1);
		heavy.reply(hungPosts[0].id, { finally: true });
		expect(await (await joined).json()).toEqual({ finally: true });
	});

	it("caps the number of running jobs, not callers", async () => {
		const created = hangTagged();
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });

		const first = await Promise.all(
			Array.from({ length: 64 }, (_, n) =>
				analytics({ ...HUNG, n: String(n) }),
			),
		);
		for (const response of first) expect(response.status).toBe(503);
		const [heavy] = created;
		expect(heavy.posted).toHaveLength(64);

		// A 65th key is refused without reaching the worker...
		expect((await analytics({ ...HUNG, n: "64" })).status).toBe(503);
		expect(heavy.posted).toHaveLength(64);
		// ...while a caller for a running key still joins its job.
		const joined = analytics({ ...HUNG, n: "7" });
		await Bun.sleep(5);
		expect(heavy.posted).toHaveLength(64);
		heavy.reply(heavy.posted[7].id, { n: 7 });
		expect(await (await joined).json()).toEqual({ n: 7 });
	});
});
