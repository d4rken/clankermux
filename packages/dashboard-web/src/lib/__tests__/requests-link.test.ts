import { describe, expect, it } from "bun:test";
import { buildLanes, type Lane, type LiveEvent } from "../live-activity";
import {
	laneRequestsHref,
	requestDetailsHref,
	resolveMarkHref,
} from "../requests-link";

const WINDOW = 180_000;
const T0 = 1_700_000_000_000;
const PLOT_WIDTH = 720;
/** Lane row height, matching LANE_HEIGHT in LiveActivityLanes. */
const LANE_HEIGHT = 28;

function event(over: Partial<LiveEvent> = {}): LiveEvent {
	return {
		id: "r1",
		ts: T0 - 10_000,
		project: "clankermux",
		model: "claude-opus-5",
		tokens: 5_000,
		status: "ok",
		durationMs: 1200,
		tokensPerSecond: null,
		account: "backup2-darken",
		...over,
	};
}

/** x of a mark's centre, matching the view's `xOf` + right-hand inset. */
function xOfTs(ts: number): number {
	const usable = PLOT_WIDTH - 8;
	return usable - ((T0 - ts) * usable) / WINDOW;
}

describe("requestDetailsHref", () => {
	it("points at the Requests page with the request selected", () => {
		expect(requestDetailsHref("req-1")).toBe("/requests?request=req-1");
	});

	it("encodes ids that would otherwise change the query string", () => {
		expect(requestDetailsHref("a&b=c")).toBe("/requests?request=a%26b%3Dc");
		expect(requestDetailsHref("a#b")).toBe("/requests?request=a%23b");
	});
});

describe("laneRequestsHref", () => {
	it("filters to a named project", () => {
		expect(laneRequestsHref({ kind: "project", project: "clankermux" })).toBe(
			"/requests?project=clankermux",
		);
	});

	it("selects the empty bucket with its own flag", () => {
		expect(laneRequestsHref({ kind: "no-project" })).toBe(
			"/requests?noProject=1",
		);
	});

	it("has no link for the overflow lane", () => {
		// It aggregates several projects, so no single project filter expresses
		// it — a link would silently show a subset.
		expect(laneRequestsHref({ kind: "other" })).toBeNull();
	});

	it("encodes names that carry query, fragment or path syntax", () => {
		expect(laneRequestsHref({ kind: "project", project: "a&b" })).toBe(
			"/requests?project=a%26b",
		);
		expect(laneRequestsHref({ kind: "project", project: "a?b" })).toBe(
			"/requests?project=a%3Fb",
		);
		expect(laneRequestsHref({ kind: "project", project: "a#b" })).toBe(
			"/requests?project=a%23b",
		);
		expect(laneRequestsHref({ kind: "project", project: "my proj" })).toBe(
			"/requests?project=my+proj",
		);
		expect(laneRequestsHref({ kind: "project", project: "home/darken" })).toBe(
			"/requests?project=home%2Fdarken",
		);
	});

	it("keeps a project named 'all' distinguishable from no filter", () => {
		// The old wire format read "all" as "no project filter", so this link
		// used to show every request instead of that project's.
		expect(laneRequestsHref({ kind: "project", project: "all" })).toBe(
			"/requests?project=all",
		);
	});

	it("keeps a project named 'no-project' distinct from the empty bucket", () => {
		expect(laneRequestsHref({ kind: "project", project: "no-project" })).toBe(
			"/requests?project=no-project",
		);
		expect(
			laneRequestsHref({ kind: "project", project: "no-project" }),
		).not.toBe(laneRequestsHref({ kind: "no-project" }));
	});
});

describe("resolveMarkHref", () => {
	const lanes: Lane[] = buildLanes(
		[
			event({ id: "recent", ts: T0 - 5_000 }),
			event({ id: "older", ts: T0 - 20_000 }),
			event({ id: "other-lane", ts: T0 - 5_000, project: "herdr" }),
		],
		T0,
		WINDOW,
		6,
	).lanes;

	const midLaneY = (index: number) => index * LANE_HEIGHT + LANE_HEIGHT / 2;

	it("opens the mark under the pointer", () => {
		const href = resolveMarkHref(
			lanes,
			xOfTs(T0 - 5_000),
			midLaneY(0),
			T0,
			WINDOW,
			PLOT_WIDTH,
		);
		expect(href).toBe(requestDetailsHref("recent"));
	});

	it("still opens a mark a few pixels away", () => {
		// A 5px dot is not a target anyone lands on exactly; the cap is a
		// tolerance, not a demand for a pixel-perfect hit.
		const href = resolveMarkHref(
			lanes,
			xOfTs(T0 - 5_000) - 6,
			midLaneY(0),
			T0,
			WINDOW,
			PLOT_WIDTH,
		);
		expect(href).toBe(requestDetailsHref("recent"));
	});

	it("resolves the second lane from the row the pointer is in", () => {
		const href = resolveMarkHref(
			lanes,
			xOfTs(T0 - 5_000),
			midLaneY(1),
			T0,
			WINDOW,
			PLOT_WIDTH,
		);
		expect(href).toBe(requestDetailsHref("other-lane"));
	});

	it("opens nothing on empty space inside a populated lane", () => {
		// hitTest returns the nearest mark in the row at any distance, which is
		// right for a tooltip and wrong for a click: this x is minutes away from
		// both marks in lane 0.
		expect(
			resolveMarkHref(lanes, 20, midLaneY(0), T0, WINDOW, PLOT_WIDTH),
		).toBeNull();
	});

	it("opens nothing below the last lane", () => {
		expect(
			resolveMarkHref(lanes, xOfTs(T0 - 5_000), 500, T0, WINDOW, PLOT_WIDTH),
		).toBeNull();
	});

	it("opens nothing when there are no lanes at all", () => {
		expect(resolveMarkHref([], 100, 10, T0, WINDOW, PLOT_WIDTH)).toBeNull();
	});

	it("gives a big mark a proportionally larger click target", () => {
		// The cap is radius-relative: a 200k-token mark is drawn wider, so the
		// distance that still counts as hitting it is wider too.
		const big = buildLanes(
			[event({ id: "big", ts: T0 - 5_000, tokens: 200_000 })],
			T0,
			WINDOW,
			6,
		).lanes;
		const small = buildLanes(
			[event({ id: "small", ts: T0 - 5_000, tokens: 1 })],
			T0,
			WINDOW,
			6,
		).lanes;

		const offset = xOfTs(T0 - 5_000) + 12;
		expect(
			resolveMarkHref(big, offset, midLaneY(0), T0, WINDOW, PLOT_WIDTH),
		).toBe(requestDetailsHref("big"));
		expect(
			resolveMarkHref(small, offset, midLaneY(0), T0, WINDOW, PLOT_WIDTH),
		).toBeNull();
	});
});
