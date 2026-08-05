import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lane, LiveEvent, LiveStatus } from "../../../lib/live-activity";
import { buildLanes } from "../../../lib/live-activity";
import {
	hitTest,
	LiveActivityLanesView,
	unknownRegions,
} from "../LiveActivityLanes";

const WINDOW = 180_000;
const T0 = 1_700_000_000_000;
const PLOT_WIDTH = 720;

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

function render(
	props: Partial<Parameters<typeof LiveActivityLanesView>[0]> = {},
) {
	const lanes: Lane[] =
		props.lanes ?? buildLanes([event()], T0, WINDOW, 6).lanes;
	return renderToStaticMarkup(
		<LiveActivityLanesView
			lanes={lanes}
			now={T0}
			windowMs={WINDOW}
			plotWidth={PLOT_WIDTH}
			connected={true}
			outages={[]}
			historyEdge={null}
			primed={true}
			{...props}
		/>,
	);
}

describe("LiveActivityLanesView", () => {
	it("distinguishes an empty window from a stream that has not primed", () => {
		// These look identical if both render "no requests", but they mean very
		// different things: one is a quiet system, the other is no data yet.
		expect(render({ lanes: [], primed: true })).toContain("No requests");
		expect(render({ lanes: [], primed: false })).toContain(
			"Waiting for the request stream",
		);
	});

	it("writes every lane total out as text, not only into the marks", () => {
		const lanes = buildLanes(
			[
				event({ id: "a", tokens: 1_000 }),
				event({ id: "b", tokens: 2_000, status: "rate_limited" }),
				event({ id: "c", tokens: 3_000, status: "error" }),
			],
			T0,
			WINDOW,
			6,
		).lanes;

		const html = render({ lanes });

		expect(html).toContain("3 req");
		// 429s get their own label rather than being merged into "err": amber
		// is below the contrast floor on the light surface and needs one.
		expect(html).toContain("1 429");
		expect(html).toContain("1 err");
	});

	it("gives each status its own shape, so nothing is colour-alone", () => {
		const shapeFor = (status: LiveStatus) =>
			render({
				lanes: buildLanes([event({ status })], T0, WINDOW, 6).lanes,
			});

		// 429 is a triangle, a hard failure is a cross, in-flight work is a
		// hollow ring, and a completed request is a filled dot.
		expect(shapeFor("rate_limited")).toContain("<polygon");
		expect(shapeFor("error")).toContain("<line");
		expect(shapeFor("streaming")).toContain('fill="none"');
		expect(shapeFor("ok")).toContain("<circle");
	});

	it("marks a pending request differently from a streaming one", () => {
		// Waiting on the upstream and actively receiving bytes are different
		// situations — one may be a stall, the other never is.
		expect(
			render({
				lanes: buildLanes([event({ status: "pending" })], T0, WINDOW, 6).lanes,
			}),
		).toContain("stroke-dasharray");
		expect(
			render({
				lanes: buildLanes([event({ status: "streaming" })], T0, WINDOW, 6)
					.lanes,
			}),
		).not.toContain("stroke-dasharray");
	});

	it("describes the lanes for a screen reader", () => {
		const html = render();
		expect(html).toContain("Request activity over the last 3 minutes");
		expect(html).toContain("clankermux");
	});

	it("reports the in-flight count and the request rate", () => {
		const lanes = buildLanes(
			[event({ id: "a", status: "streaming" }), event({ id: "b" })],
			T0,
			WINDOW,
			6,
		).lanes;

		expect(render({ lanes })).toContain("1 active");
	});

	it("says so when the stream is down", () => {
		expect(render({ connected: false })).toContain("reconnecting");
		expect(render({ connected: true })).toContain("live");
	});

	it("renders without interaction wiring, so it is server-safe", () => {
		// The container passes handlers; the view must not require them.
		expect(() => render({ plot: undefined })).not.toThrow();
	});
});

describe("unknownRegions", () => {
	it("hatches history the backfill could not reach", () => {
		const regions = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			historyEdge: T0 - 60_000,
			outages: [],
		});

		expect(regions).toHaveLength(1);
		expect(regions[0].from).toBe(T0 - WINDOW);
		expect(regions[0].to).toBe(T0 - 60_000);
	});

	it("does not hatch when the loaded history already covers the window", () => {
		expect(
			unknownRegions({
				now: T0,
				windowMs: WINDOW,
				historyEdge: T0 - WINDOW - 1000,
				outages: [],
			}),
		).toHaveLength(0);
	});

	it("hatches a connection outage so the gap cannot read as idle", () => {
		// An empty stretch during an outage is the one thing this card must
		// never present as "nothing happened".
		const regions = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			historyEdge: null,
			outages: [{ from: T0 - 30_000, to: null }],
		});

		expect(regions).toHaveLength(1);
		expect(regions[0].label).toContain("disconnected");
	});

	it("stops a closed outage where it ended, not at the present", () => {
		// The regression this guards: extending a finished outage to `now`
		// hatches every healthy request since the reconnect as unknown.
		const [region] = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			historyEdge: null,
			outages: [{ from: T0 - 60_000, to: T0 - 50_000 }],
		});

		expect(region.from).toBe(T0 - 60_000);
		expect(region.to).toBe(T0 - 50_000);
	});

	it("hatches each outage separately", () => {
		const regions = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			historyEdge: null,
			outages: [
				{ from: T0 - 90_000, to: T0 - 80_000 },
				{ from: T0 - 40_000, to: T0 - 30_000 },
			],
		});

		expect(regions).toHaveLength(2);
		expect(regions.map((r) => r.key)).toEqual([
			`outage-${T0 - 90_000}`,
			`outage-${T0 - 30_000 - 10_000}`,
		]);
	});

	it("clips an outage that started before the window to the window", () => {
		const [region] = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			historyEdge: null,
			outages: [{ from: T0 - WINDOW * 5, to: null }],
		});

		expect(region.from).toBe(T0 - WINDOW);
		// Still down, so it genuinely does run to the present.
		expect(region.to).toBe(T0);
	});

	it("drops an outage that has scrolled entirely out of the window", () => {
		expect(
			unknownRegions({
				now: T0,
				windowMs: WINDOW,
				historyEdge: null,
				outages: [{ from: T0 - WINDOW * 3, to: T0 - WINDOW * 2 }],
			}),
		).toHaveLength(0);
	});
});

describe("hitTest", () => {
	const lanes = buildLanes(
		[
			event({ id: "old", ts: T0 - 150_000 }),
			event({ id: "recent", ts: T0 - 5_000 }),
			event({ id: "other-lane", ts: T0 - 5_000, project: "herdr" }),
		],
		T0,
		WINDOW,
		6,
	).lanes;

	it("picks the nearest mark in time, not an exact pixel hit", () => {
		// Landing dead-centre on a 5px dot is not something anyone does.
		const hit = hitTest(lanes, PLOT_WIDTH - 20, 14, T0, WINDOW, PLOT_WIDTH);
		expect(hit?.event.id).toBe("recent");
	});

	it("selects the lane from the row the pointer is over", () => {
		const first = hitTest(lanes, PLOT_WIDTH - 20, 14, T0, WINDOW, PLOT_WIDTH);
		const second = hitTest(lanes, PLOT_WIDTH - 20, 42, T0, WINDOW, PLOT_WIDTH);

		expect(first?.laneIndex).toBe(0);
		expect(second?.laneIndex).toBe(1);
		expect(second?.event.project).toBe("herdr");
	});

	it("finds the old mark when the pointer is at the left edge", () => {
		const hit = hitTest(lanes, 4, 14, T0, WINDOW, PLOT_WIDTH);
		expect(hit?.event.id).toBe("old");
	});

	it("returns nothing below the last lane", () => {
		expect(hitTest(lanes, 100, 500, T0, WINDOW, PLOT_WIDTH)).toBeNull();
	});
});
