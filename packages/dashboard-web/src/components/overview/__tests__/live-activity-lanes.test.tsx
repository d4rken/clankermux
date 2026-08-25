import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { COLORS, MODEL_PALETTE } from "../../../constants";
import type { SeriesPalette } from "../../../hooks/useSeriesPalette";
import type { Lane, LiveEvent, LiveStatus } from "../../../lib/live-activity";
import { buildLanes, hitTest } from "../../../lib/live-activity";
import { getModelColor } from "../../../lib/model-colors";
import { LiveActivityLanesView, unknownRegions } from "../LiveActivityLanes";

const WINDOW = 180_000;
const T0 = 1_700_000_000_000;
const PLOT_WIDTH = 720;

/**
 * The dark-ground palette, built by hand rather than through the hook.
 *
 * `useSeriesPalette` reads the class off `<html>` and subscribes to it, which
 * needs a DOM; these are `renderToStaticMarkup` tests. Passing the palette as a
 * prop is what makes that possible, so constructing one here is the point of
 * the prop, not a workaround for it.
 */
const PALETTE: SeriesPalette = {
	mode: "dark",
	hue: MODEL_PALETTE,
	sequence: [],
	forModel: (model: string) => getModelColor(model, "dark"),
};

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
			palette={PALETTE}
			{...props}
		/>,
	);
}

/**
 * The plot only. Model names and hues appear in three places — the marks, their
 * tooltips, and the legend — so a whole-markup `toContain` cannot tell "this
 * mark is red" from "red is listed in the key below".
 */
function plotOf(markup: string): string {
	const start = markup.indexOf("<svg");
	const end = markup.indexOf("</svg>");
	return markup.slice(start, end);
}

/** The legend strip only, for assertions about what the key lists and in what order. */
function legendOf(markup: string): string {
	return markup.slice(markup.indexOf("</svg>"));
}

describe("LiveActivityLanesView colour encoding", () => {
	it("gives each model its own mark colour", () => {
		// The defect this replaced: every healthy request drew in one blue,
		// because colour keyed off status and 99.7% of requests succeed. Two
		// models in the same lane have to come out as two different fills.
		const markup = render({
			lanes: buildLanes(
				[
					event({ id: "a", model: "claude-opus-5" }),
					event({ id: "b", model: "claude-sonnet-5" }),
				],
				T0,
				WINDOW,
				6,
			).lanes,
		});
		expect(markup).toContain(MODEL_PALETTE.azure); // claude-opus-5
		expect(markup).toContain(MODEL_PALETTE.emerald); // claude-sonnet-5
	});

	it("keeps amber and red for failures, whatever model produced them", () => {
		// Colour-coding models is only safe while the status hues stay
		// unambiguous. A 429 and an error must not pick up their model's hue, or
		// the two encodings become indistinguishable on the same plot.
		const markup = render({
			lanes: buildLanes(
				[
					event({ id: "a", model: "claude-opus-5", status: "rate_limited" }),
					event({ id: "b", model: "claude-sonnet-5", status: "error" }),
				],
				T0,
				WINDOW,
				6,
			).lanes,
		});
		const plot = plotOf(markup);
		expect(plot).toContain(COLORS.warning);
		expect(plot).toContain(COLORS.error);
		// Scoped to the plot: the legend still lists both models, correctly — a
		// model whose every request failed is still a model that ran.
		expect(plot).not.toContain(MODEL_PALETTE.azure);
		expect(plot).not.toContain(MODEL_PALETTE.emerald);
	});

	it("colours an in-flight request by the model it is waiting on", () => {
		// `pending` arrives before any usage resolves, but the REQUESTED model is
		// known from ingress. Leaving it neutral would blank the colour of
		// exactly the requests this card exists to show.
		const markup = render({
			lanes: buildLanes(
				[event({ id: "a", model: "claude-fable-5", status: "pending" })],
				T0,
				WINDOW,
				6,
			).lanes,
		});
		expect(markup).toContain(MODEL_PALETTE.teal);
	});

	it("lists the models on the plot in a legend, in a stable order", () => {
		// Ordered by name rather than by volume: a volume-ordered legend
		// reshuffles itself as the window rolls and one model overtakes another.
		// Sonnet deliberately outnumbers Fable 2:1. Alphabetical puts Fable first,
		// volume-descending puts Sonnet first — so this fixture can tell the two
		// orderings apart. With Fable in the majority both rules agree and the
		// test would pass against the behaviour it is meant to rule out.
		const markup = render({
			lanes: buildLanes(
				[
					event({ id: "a", model: "claude-sonnet-5" }),
					event({ id: "b", model: "claude-sonnet-5" }),
					event({ id: "c", model: "claude-fable-5" }),
				],
				T0,
				WINDOW,
				6,
			).lanes,
		});
		// Scoped to the legend, since the marks' own tooltips name models in plot
		// order.
		const legend = legendOf(markup);
		expect(legend.indexOf("claude-fable-5")).toBeLessThan(
			legend.indexOf("claude-sonnet-5"),
		);
	});

	it("names the model on the mark itself, not only in the legend", () => {
		// Hue is only decodable against the legend, and there are more models
		// than anyone memorises. The tooltip has to stand alone — asserted
		// against the plot, or the legend entry would satisfy it on its own.
		expect(plotOf(render())).toContain("claude-opus-5");
	});

	it("gives a Codex model its own legend swatch, not a Claude model's", () => {
		// gpt-5.6-sol is ~15% of live requests. It used to reach the index-based
		// fallback, whose entries are hues registered Claude models already wear,
		// so the legend could show two rows with the same swatch.
		const markup = render({
			lanes: buildLanes(
				[
					event({ id: "a", model: "gpt-5.6-sol" }),
					event({ id: "b", model: "claude-opus-5" }),
				],
				T0,
				WINDOW,
				6,
			).lanes,
		});
		const legend = legendOf(markup);
		expect(legend).toContain("gpt-5.6-sol");
		expect(getModelColor("gpt-5.6-sol", "dark")).not.toBe(
			getModelColor("claude-opus-5", "dark"),
		);
	});
});

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
