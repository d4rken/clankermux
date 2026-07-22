import { afterEach, describe, expect, it } from "bun:test";
import type { APIContext } from "../../types";
import {
	__setDashboardWorkerFactoryForTests,
	__setDashboardWorkerTimeoutsForTests,
	clearAnalyticsCachesForTests,
	createIsolatedAnalyticsHandler,
	createIsolatedStatsHandler,
	type DashboardWorkerLike,
	getWorkerTimeoutMs,
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
 * Controllable dashboard worker. Replies (via onmessage) to the kinds listed in
 * `replyKinds` after `replyDelayMs`; requests of any other kind hang forever,
 * standing in for a query that runs past its deadline.
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
			replyKinds: Set<DashboardWorkerKind>;
			replyDelayMs?: number;
		},
	) {}

	postMessage(message: AnalyticsWorkerRequest): void {
		this.posted.push(message);
		const kind: DashboardWorkerKind = message.kind ?? "analytics";
		if (!this.opts.replyKinds.has(kind)) return; // simulate a hang
		setTimeout(() => {
			this.onmessage?.({
				data: {
					id: message.id,
					ok: true,
					status: 200,
					body: JSON.stringify({ ok: true }),
				},
			} as MessageEvent<AnalyticsWorkerResponse>);
		}, this.opts.replyDelayMs ?? 5);
	}

	terminate(): void {
		this.terminateCount++;
	}

	unref(): void {}
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
			"memory-history",
			"cache-keepalive-history",
			"cache-effectiveness",
			"payments-summary",
		] as const) {
			expect(getWorkerTimeoutMs(kind)).toBe(15_000);
			expect(getWorkerTimeoutMs("analytics")).toBeGreaterThan(
				getWorkerTimeoutMs(kind),
			);
		}
	});
});

describe("dashboard worker timeout isolation", () => {
	it("a soft-timed-out request does not reject siblings or terminate the worker", async () => {
		let created = 0;
		let fake: FakeDashboardWorker | undefined;
		__setDashboardWorkerFactoryForTests(() => {
			created++;
			fake = new FakeDashboardWorker({ replyKinds: new Set(["stats"]) });
			return fake;
		});
		// Soft fires quickly; hard stays out of the way for this test.
		__setDashboardWorkerTimeoutsForTests({ soft: 40, hard: 5_000 });

		const analyticsPromise = createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all" }),
		);
		const statsPromise = createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h" }),
		);

		const [analyticsRes, statsRes] = await Promise.all([
			analyticsPromise,
			statsPromise,
		]);

		// The sibling stats read completed even though analytics hung.
		expect(statsRes.status).toBe(200);
		// Analytics itself was rejected as a timeout (503 ServiceUnavailable).
		expect(analyticsRes.status).toBe(503);
		// One shared worker served both, and the soft timeout left it alive.
		expect(created).toBe(1);
		expect(fake?.terminateCount).toBe(0);
	});

	it("terminates and rebuilds a genuinely wedged worker after the hard deadline", async () => {
		let created = 0;
		const fakes: FakeDashboardWorker[] = [];
		__setDashboardWorkerFactoryForTests(() => {
			created++;
			const f = new FakeDashboardWorker({ replyKinds: new Set() }); // never replies
			fakes.push(f);
			return f;
		});
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 60 });

		const first = await createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all" }),
		);
		// Soft timeout answered the caller...
		expect(first.status).toBe(503);
		// ...but the worker is not terminated yet (it might still be healthy-slow).
		expect(fakes[0].terminateCount).toBe(0);

		// Past the hard deadline, the wedged worker is torn down.
		await Bun.sleep(90);
		expect(fakes[0].terminateCount).toBe(1);
		expect(created).toBe(1);

		// The next request rebuilds a fresh worker rather than reusing the dead one.
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 5_000 });
		const second = await createIsolatedStatsHandler(fakeContext)(
			new URLSearchParams({ range: "24h" }),
		);
		expect(second.status).toBe(503);
		expect(created).toBe(2);
	});

	it("does not tear down a slow-but-alive worker when siblings still complete", async () => {
		let created = 0;
		let fake: FakeDashboardWorker | undefined;
		__setDashboardWorkerFactoryForTests(() => {
			created++;
			fake = new FakeDashboardWorker({
				replyKinds: new Set(["stats"]),
				replyDelayMs: 2,
			});
			return fake;
		});
		__setDashboardWorkerTimeoutsForTests({ soft: 20, hard: 50 });

		// Analytics hangs and soft-times-out; its hard watchdog is armed at 50ms.
		const analyticsPromise = createIsolatedAnalyticsHandler(fakeContext)(
			new URLSearchParams({ range: "all" }),
		);

		// Keep the worker demonstrably alive across the analytics hard deadline by
		// completing sibling stats reads back-to-back for longer than `hard` ms.
		// The unique `n` param defeats the response cache so each is a real
		// round-trip that refreshes the worker's activity timestamp.
		const start = Date.now();
		let siblingsOk = true;
		while (Date.now() - start < 90) {
			const res = await createIsolatedStatsHandler(fakeContext)(
				new URLSearchParams({ range: "24h", n: String(Date.now()) }),
			);
			if (res.status !== 200) siblingsOk = false;
		}

		const analyticsRes = await analyticsPromise;
		expect(analyticsRes.status).toBe(503); // analytics itself soft-timed-out
		expect(siblingsOk).toBe(true); // siblings kept flowing throughout
		expect(created).toBe(1); // worker was never rebuilt...
		expect(fake?.terminateCount).toBe(0); // ...because it was never torn down
	});
});
