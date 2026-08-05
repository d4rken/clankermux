import { describe, expect, it } from "bun:test";
import type { RequestResponse } from "@clankermux/types";
import {
	ageOpacity,
	applyHistoryRows,
	applyStreamEvent,
	buildLanes,
	type LiveStore,
	LOST_AFTER_MS,
	laneKeyOf,
	markRadius,
	pruneLiveStore,
	sweepLostEvents,
} from "../live-activity";

const WINDOW = 180_000;
const T0 = 1_700_000_000_000;

function store(): LiveStore {
	return new Map();
}

function summaryPayload(over: Partial<RequestResponse> = {}): RequestResponse {
	return {
		id: "r1",
		timestamp: new Date(T0).toISOString(),
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct-1",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 1200,
		failoverAttempts: 0,
		model: "claude-opus-5",
		totalTokens: 5000,
		project: "clankermux",
		...over,
	};
}

describe("applyStreamEvent — phases", () => {
	it("creates a pending event from an ingress", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: "claude-opus-5",
		});

		expect(s.get("r1")).toMatchObject({
			id: "r1",
			ts: T0,
			project: "clankermux",
			model: "claude-opus-5",
			status: "pending",
		});
	});

	it("promotes pending to streaming on start and keeps the arrival time", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: "claude-opus-5",
		});
		applyStreamEvent(s, {
			type: "start",
			id: "r1",
			// A failover attempt carries its own timestamp; the mark must stay
			// where the request actually arrived rather than creeping right.
			timestamp: T0 + 30_000,
			method: "POST",
			path: "/v1/messages",
			accountId: "acct-1",
			statusCode: 200,
			project: "clankermux",
			model: "claude-opus-5",
		});

		expect(s.get("r1")?.status).toBe("streaming");
		expect(s.get("r1")?.ts).toBe(T0);
	});

	it("settles a streaming event on summary", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "start",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			accountId: "acct-1",
			statusCode: 200,
			project: "clankermux",
			model: "claude-opus-5",
		});
		applyStreamEvent(s, { type: "summary", payload: summaryPayload() });

		expect(s.get("r1")).toMatchObject({
			status: "ok",
			tokens: 5000,
			durationMs: 1200,
		});
	});

	it("never lets a late ingress or start walk a settled event backwards", () => {
		const s = store();
		applyStreamEvent(s, { type: "summary", payload: summaryPayload() });
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: "claude-opus-5",
		});

		expect(s.get("r1")?.status).toBe("ok");
	});

	it("merges a second summary rather than replacing the first", () => {
		// request-recorder's patchUsage re-emits a summary for the same id when
		// late usage lands. A replace would blank the fields the first carried.
		const s = store();
		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({ totalTokens: undefined, responseTimeMs: 900 }),
		});
		expect(s.get("r1")?.tokens).toBeNull();

		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({ totalTokens: 8000, responseTimeMs: undefined }),
		});

		expect(s.get("r1")?.tokens).toBe(8000);
		// Carried over from the first summary, not nulled by the second.
		expect(s.get("r1")?.durationMs).toBe(900);
	});
});

describe("applyStreamEvent — retraction", () => {
	it("removes a pending event on ingress-end", () => {
		// These requests are never written to Request History either, so the
		// live view must not keep a mark the rest of the app has no row for.
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: null,
			model: null,
		});
		applyStreamEvent(s, { type: "ingress-end", id: "r1", statusCode: 400 });

		expect(s.has("r1")).toBe(false);
	});

	it("leaves a settled event alone on a stray ingress-end", () => {
		const s = store();
		applyStreamEvent(s, { type: "summary", payload: summaryPayload() });
		applyStreamEvent(s, { type: "ingress-end", id: "r1", statusCode: 200 });

		expect(s.get("r1")?.status).toBe("ok");
	});
});

describe("applyStreamEvent — snapshot reconciliation", () => {
	it("adopts in-flight requests the client has never seen", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "snapshot",
			active: [
				{
					id: "r9",
					timestamp: T0,
					method: "POST",
					path: "/v1/messages",
					project: "herdr",
					model: "claude-opus-5",
					phase: "streaming",
					accountId: "acct-1",
					statusCode: 200,
				},
			],
		});

		expect(s.get("r9")).toMatchObject({
			status: "streaming",
			project: "herdr",
		});
	});

	it("marks locally-active requests the server no longer knows about as lost", () => {
		// After a reconnect the snapshot is authoritative about what is still
		// running. An entry missing from it ended during the outage — we just
		// never saw how, which is `lost`, not success and not failure.
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "gone",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: null,
		});
		applyStreamEvent(s, { type: "snapshot", active: [] });

		expect(s.get("gone")?.status).toBe("lost");
	});

	it("does not disturb already-settled events", () => {
		const s = store();
		applyStreamEvent(s, { type: "summary", payload: summaryPayload() });
		applyStreamEvent(s, { type: "snapshot", active: [] });

		expect(s.get("r1")?.status).toBe("ok");
	});

	it("lets a real outcome overwrite a lost verdict", () => {
		// The DB backfill that follows a reconnect knows how the request
		// actually ended; "unknown" must yield to it.
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: null,
		});
		applyStreamEvent(s, { type: "snapshot", active: [] });
		expect(s.get("r1")?.status).toBe("lost");

		applyHistoryRows(s, [summaryPayload()]);
		expect(s.get("r1")?.status).toBe("ok");
	});
});

describe("normalization", () => {
	it("classifies 429 from the status code, not the rateLimited field", () => {
		// Live summaries omit `rateLimited` entirely while the backfill sets it,
		// so the field is not a usable discriminator across both sources.
		const s = store();
		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({ statusCode: 429, success: false }),
		});

		expect(s.get("r1")?.status).toBe("rate_limited");
	});

	it("classifies a non-429 failure as an error", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({ statusCode: 500, success: false }),
		});

		expect(s.get("r1")?.status).toBe("error");
	});

	it("falls back to requestedModel when the upstream model is absent", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({
				model: undefined,
				requestedModel: "claude-sonnet-5",
			}),
		});

		expect(s.get("r1")?.model).toBe("claude-sonnet-5");
	});

	it("resolves an account id to a name, and passes a name through", () => {
		// The live event carries the account ID; the backfill endpoint carries
		// the NAME. Both must render as the same string.
		const ctx = {
			accountName: (id: string) => (id === "acct-1" ? "backup2-darken" : null),
		};

		const live = store();
		applyStreamEvent(live, { type: "summary", payload: summaryPayload() }, ctx);
		expect(live.get("r1")?.account).toBe("backup2-darken");

		const history = store();
		applyHistoryRows(
			history,
			[summaryPayload({ accountUsed: "backup2-darken" })],
			ctx,
		);
		expect(history.get("r1")?.account).toBe("backup2-darken");
	});

	it("rejects nonsense tokens and durations rather than charting them", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({
				totalTokens: Number.NaN,
				responseTimeMs: -5,
			}),
		});

		expect(s.get("r1")?.tokens).toBeNull();
		expect(s.get("r1")?.durationMs).toBeNull();
	});

	it("drops a row whose timestamp is unparseable", () => {
		const s = store();
		applyHistoryRows(s, [summaryPayload({ timestamp: "not-a-date" })]);

		expect(s.size).toBe(0);
	});
});

describe("pruneLiveStore", () => {
	const ingressAt = (s: LiveStore, id: string, ts: number) =>
		applyStreamEvent(s, {
			type: "ingress",
			id,
			timestamp: ts,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: null,
		});

	it("drops completed events that fall out of the window", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "summary",
			payload: summaryPayload({
				id: "old",
				timestamp: new Date(T0).toISOString(),
			}),
		});

		pruneLiveStore(s, T0 + WINDOW + 1, WINDOW);
		expect(s.has("old")).toBe(false);
	});

	it("KEEPS an active request whose start has aged out of the window", () => {
		// A four-minute stream is exactly the work this view exists to show.
		// Window-pruning it would delete the request while it is still running.
		const s = store();
		ingressAt(s, "long", T0);

		pruneLiveStore(s, T0 + WINDOW + 60_000, WINDOW);
		expect(s.get("long")?.status).toBe("pending");
	});

	it("evicts completed events before active ones when over the cap", () => {
		const s = store();
		ingressAt(s, "active", T0 + 1000);
		for (let i = 0; i < 10; i++) {
			applyStreamEvent(s, {
				type: "summary",
				payload: summaryPayload({
					id: `done-${i}`,
					timestamp: new Date(T0 + i).toISOString(),
				}),
			});
		}

		pruneLiveStore(s, T0 + 1000, WINDOW, 5);

		expect(s.size).toBe(5);
		expect(s.has("active")).toBe(true);
	});
});

describe("sweepLostEvents", () => {
	it("marks an active request with no terminal as lost, not as an error", () => {
		// A dropped connection or a proxy restart leaves an entry with no
		// outcome. Calling that an error would invent a failure that may not
		// have happened.
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: null,
		});

		sweepLostEvents(s, T0 + LOST_AFTER_MS + 1);
		expect(s.get("r1")?.status).toBe("lost");
	});

	it("leaves a young active request alone", () => {
		const s = store();
		applyStreamEvent(s, {
			type: "ingress",
			id: "r1",
			timestamp: T0,
			method: "POST",
			path: "/v1/messages",
			project: "clankermux",
			model: null,
		});

		sweepLostEvents(s, T0 + 60_000);
		expect(s.get("r1")?.status).toBe("pending");
	});
});

describe("laneKeyOf", () => {
	it("cannot collide a real project with the no-project bucket", () => {
		expect(laneKeyOf("(no project)")).not.toBe(laneKeyOf(null));
	});

	it("cannot collide a real project with the overflow bucket", () => {
		// A project literally named "Other (3 projects)" must not merge into the
		// synthetic overflow lane.
		expect(laneKeyOf("Other (3 projects)")).not.toBe("other");
	});
});

describe("buildLanes", () => {
	function completed(
		id: string,
		project: string | null,
		ts: number,
		over = {},
	) {
		return {
			id,
			ts,
			project,
			model: "claude-opus-5",
			tokens: 1000,
			status: "ok" as const,
			durationMs: 100,
			tokensPerSecond: null,
			account: null,
			...over,
		};
	}

	it("groups by project and totals each lane", () => {
		const { lanes } = buildLanes(
			[
				completed("a", "clankermux", T0),
				completed("b", "clankermux", T0 + 1),
				completed("c", "herdr", T0),
			],
			T0 + 1000,
			WINDOW,
			6,
		);

		const cm = lanes.find((l) => l.label === "clankermux");
		expect(cm?.requests).toBe(2);
		expect(cm?.tokens).toBe(2000);
		expect(lanes.find((l) => l.label === "herdr")?.requests).toBe(1);
	});

	it("counts 429s and errors separately", () => {
		// Amber fails the contrast floor on the light surface, so it needs a
		// label of its own rather than being merged into a generic error count.
		const { lanes } = buildLanes(
			[
				completed("a", "clankermux", T0, { status: "rate_limited" }),
				completed("b", "clankermux", T0, { status: "error" }),
				completed("c", "clankermux", T0),
			],
			T0 + 1000,
			WINDOW,
			6,
		);

		expect(lanes[0].rateLimited).toBe(1);
		expect(lanes[0].errors).toBe(1);
	});

	it("labels the null-project bucket without claiming a project name", () => {
		const { lanes } = buildLanes(
			[completed("a", null, T0)],
			T0 + 1000,
			WINDOW,
			6,
		);

		expect(lanes[0].label).toBe("(no project)");
		expect(lanes[0].key).toBe(laneKeyOf(null));
	});

	it("folds the tail into a single Other lane with aggregated totals", () => {
		const events = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].flatMap((p, i) =>
			// Descending volume so the fold order is unambiguous.
			Array.from({ length: 10 - i }, (_, n) =>
				completed(`${p}-${n}`, p, T0 + n),
			),
		);

		const { lanes } = buildLanes(events, T0 + 1000, WINDOW, 6);

		expect(lanes).toHaveLength(6);
		const other = lanes[lanes.length - 1];
		expect(other.key).toBe("other");
		expect(other.label).toBe("Other (2 projects)");
		// Volumes run 10, 9, 8, 7, 6, 5, 4; the two smallest fold in.
		expect(other.requests).toBe(5 + 4);
	});

	it("keeps lane order stable as volumes change", () => {
		// Re-sorting every tick would move rows under the pointer, move keyboard
		// focus, and shuffle projects in and out of Other mid-inspection.
		const first = buildLanes(
			[completed("a", "alpha", T0), completed("b", "beta", T0)],
			T0 + 1000,
			WINDOW,
			6,
		);
		const alphaFirst = first.lanes.map((l) => l.label);

		// beta overtakes alpha by volume.
		const second = buildLanes(
			[
				completed("a", "alpha", T0),
				completed("b", "beta", T0),
				completed("c", "beta", T0),
				completed("d", "beta", T0),
			],
			T0 + 1000,
			WINDOW,
			6,
			first.order,
		);

		expect(second.lanes.map((l) => l.label)).toEqual(alphaFirst);
	});

	it("drops a lane once it has no events left in the window", () => {
		const first = buildLanes(
			[completed("a", "alpha", T0), completed("b", "beta", T0)],
			T0 + 1000,
			WINDOW,
			6,
		);

		const second = buildLanes(
			[completed("b", "beta", T0)],
			T0 + 1000,
			WINDOW,
			6,
			first.order,
		);

		expect(second.lanes.map((l) => l.label)).toEqual(["beta"]);
		expect(second.order).toEqual([laneKeyOf("beta")]);
	});

	it("keeps an out-of-window active request in its lane", () => {
		const { lanes } = buildLanes(
			[
				completed("long", "clankermux", T0 - WINDOW * 2, {
					status: "streaming",
				}),
			],
			T0,
			WINDOW,
			6,
		);

		expect(lanes).toHaveLength(1);
		expect(lanes[0].active).toBe(1);
	});

	it("does not count a pinned long-runner as an arrival in the window", () => {
		// It is drawn because it is still happening, but counting it would make
		// the card report requests — and a request RATE — for a window in which
		// nothing actually arrived.
		const { lanes } = buildLanes(
			[
				completed("long", "clankermux", T0 - WINDOW * 2, {
					status: "streaming",
					tokens: 9_000,
				}),
			],
			T0,
			WINDOW,
			6,
		);

		expect(lanes[0].active).toBe(1);
		expect(lanes[0].requests).toBe(0);
		expect(lanes[0].tokens).toBe(0);
	});

	it("counts an in-window active request as both", () => {
		const { lanes } = buildLanes(
			[completed("now", "clankermux", T0 - 1_000, { status: "streaming" })],
			T0,
			WINDOW,
			6,
		);

		expect(lanes[0].active).toBe(1);
		expect(lanes[0].requests).toBe(1);
	});
});

describe("markRadius", () => {
	it("grows sublinearly so one huge request cannot swallow its lane", () => {
		const small = markRadius(1_000);
		const huge = markRadius(1_000_000);

		expect(huge).toBeGreaterThan(small);
		expect(huge).toBeLessThanOrEqual(7);
		expect(small).toBeGreaterThanOrEqual(2.5);
		// 1000x the tokens must not be anywhere near 1000x the radius.
		expect(huge / small).toBeLessThan(3);
	});

	it("gives an unknown token count a neutral size", () => {
		expect(markRadius(null)).toBeGreaterThanOrEqual(2.5);
		expect(markRadius(null)).toBeLessThanOrEqual(7);
	});
});

describe("ageOpacity", () => {
	it("fades from full to a floor across the window", () => {
		expect(ageOpacity(T0, T0, WINDOW)).toBeCloseTo(1, 5);
		expect(ageOpacity(T0 - WINDOW, T0, WINDOW)).toBeCloseTo(0.35, 5);
	});

	it("clamps rather than going transparent or over-bright", () => {
		expect(ageOpacity(T0 - WINDOW * 3, T0, WINDOW)).toBeCloseTo(0.35, 5);
		expect(ageOpacity(T0 + 5_000, T0, WINDOW)).toBeCloseTo(1, 5);
	});
});
