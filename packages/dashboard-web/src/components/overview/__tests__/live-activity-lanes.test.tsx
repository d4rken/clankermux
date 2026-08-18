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
			coverageFrom={T0 - WINDOW}
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

	it("links a named project lane to its filtered request list", () => {
		const html = render();

		expect(html).toContain('href="/requests?project=clankermux"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('aria-label="Show clankermux requests"');
	});

	it("links the no-project lane to the empty bucket, not to a name", () => {
		const lanes = buildLanes([event({ project: null })], T0, WINDOW, 6).lanes;

		expect(render({ lanes })).toContain('href="/requests?noProject=1"');
	});

	it("leaves the overflow lane as plain text", () => {
		// It aggregates several projects, so no single project filter expresses
		// it and a link would silently show a subset.
		const events = ["p1", "p2", "p3"].flatMap((p, i) =>
			Array.from({ length: 3 - i }, (_, n) =>
				event({ id: `${p}-${n}`, project: p, ts: T0 - 1000 * n }),
			),
		);
		const lanes = buildLanes(events, T0, WINDOW, 1).lanes;
		const html = render({ lanes });

		expect(html).toContain("Other (2 projects)");
		expect(html).not.toMatch(/<a[^>]*>Other \(2 projects\)/);
	});

	it("keeps the lane label list out of aria-hidden now that it holds links", () => {
		// Focusable content inside an aria-hidden subtree is an accessibility
		// violation, not a cosmetic one.
		const html = render();
		const labelList = html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));

		expect(labelList).toContain('href="/requests?project=clankermux"');
		expect(labelList).not.toContain("aria-hidden");
	});

	it("offers the selected mark as a real link, not just a synthesized key", () => {
		// The plot is role="img"; Enter on an image role is not announced as
		// actionable, so keyboard and screen-reader users need native link
		// semantics for the mark they have selected.
		const html = render({ selected: event({ id: "req-42" }) });
		expect(html).toContain('href="/requests?request=req-42"');
		expect(html).toContain("Open selected request");
	});

	it("renders no selected-request link when nothing is selected", () => {
		expect(render()).not.toContain("Open selected request");
	});

	it("says the marks are clickable", () => {
		expect(render()).toContain("Click a mark to open its request.");
	});

	it("renders without interaction wiring, so it is server-safe", () => {
		// The container passes handlers; the view must not require them.
		expect(() => render({ plot: undefined })).not.toThrow();
	});

	it("states the window length it is actually showing", () => {
		expect(render({ windowMs: 10 * 60_000 })).toContain("last 10 minutes");
	});

	it("offers the window selector only when wired", () => {
		expect(
			render({ windowControl: { value: 5 * 60_000, onChange: () => {} } }),
		).toContain("Live activity time range");
		expect(render()).not.toContain("Live activity time range");
	});

	it("marks the selected window as pressed", () => {
		const html = render({
			windowMs: 10 * 60_000,
			windowControl: { value: 10 * 60_000, onChange: () => {} },
		});
		// Identity is not colour-only: the active option is exposed to
		// assistive tech via aria-pressed, not just tinted.
		expect(html).toMatch(/aria-pressed="true"[^>]*>10m|10m<\/button>/);
		expect(html).toContain('aria-pressed="true"');
	});
});

describe("axis ticks", () => {
	it("keeps the tick count readable as the window grows", () => {
		// One tick per minute puts 31 labelled ticks on a half-hour axis, which
		// overlaps its own text and reads as noise.
		const ticksFor = (windowMs: number) =>
			(render({ windowMs }).match(/-\d+m</g) ?? []).length;

		expect(ticksFor(3 * 60_000)).toBeLessThanOrEqual(6);
		expect(ticksFor(30 * 60_000)).toBeLessThanOrEqual(8);
	});
});

describe("unknownRegions", () => {
	it("hatches history the backfill could not reach", () => {
		const regions = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			coverageFrom: T0 - 60_000,
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
				coverageFrom: T0 - WINDOW - 1000,
				outages: [],
			}),
		).toHaveLength(0);
	});

	it("hatches the WHOLE window when nothing is covered", () => {
		// `null` means no history fetched and the stream never up. Treating that
		// as full coverage is how a failed backfill becomes a confident, wrong
		// claim that nothing happened.
		const [region] = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			coverageFrom: null,
			outages: [],
		});

		expect(region.from).toBe(T0 - WINDOW);
		expect(region.to).toBe(T0);
	});

	it("hatches a connection outage so the gap cannot read as idle", () => {
		// An empty stretch during an outage is the one thing this card must
		// never present as "nothing happened".
		const regions = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			coverageFrom: T0 - WINDOW,
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
			coverageFrom: T0 - WINDOW,
			outages: [{ from: T0 - 60_000, to: T0 - 50_000 }],
		});

		expect(region.from).toBe(T0 - 60_000);
		expect(region.to).toBe(T0 - 50_000);
	});

	it("hatches each outage separately", () => {
		const regions = unknownRegions({
			now: T0,
			windowMs: WINDOW,
			coverageFrom: T0 - WINDOW,
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
			coverageFrom: T0 - WINDOW,
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
				coverageFrom: T0 - WINDOW,
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
