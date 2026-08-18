import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Lane, LiveEvent } from "../../lib/live-activity";
import { buildLanes } from "../../lib/live-activity";
import { ScrollingLanes } from "./LiveActivityLanes";

/**
 * The click and keyboard paths of the Live Activity plot, mounted for real.
 *
 * `renderToStaticMarkup` cannot reach any of this: resolving a click to a mark
 * reads the SVG's live bounding rect, and the "Open selected request" link only
 * exists once focus has put a cursor on a mark. `ScrollingLanes` is mounted
 * rather than a copy of its handlers — the handlers ARE the behaviour under
 * test — with `reducedMotion` on, which is the branch that applies no scroll
 * transform and so pins the marks to the layout origin the test aims at.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WINDOW = 180_000;
const T0 = 1_700_000_000_000;
const PLOT_WIDTH = 720;
const PLOT_HEIGHT = 76;
const LANE_HEIGHT = 28;
const NOW_INSET = 8;

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

const lanes: Lane[] = buildLanes(
	[
		event({ id: "recent", ts: T0 - 5_000 }),
		event({ id: "older", ts: T0 - 150_000 }),
	],
	T0,
	WINDOW,
	6,
).lanes;

/** Plot x of a mark's centre, matching the renderer's placement. */
function xOfTs(ts: number): number {
	const usable = PLOT_WIDTH - NOW_INSET;
	return usable - ((T0 - ts) * usable) / WINDOW;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let opened: string[] = [];
let realOpen: typeof window.open;

/**
 * happy-dom has no layout engine, so the plot's rect has to be supplied. Sized
 * 1:1 with the viewBox and pinned at the origin, so a test can aim at a mark by
 * its plot-space x.
 */
function stubPlotRect(svg: SVGSVGElement) {
	svg.getBoundingClientRect = () =>
		({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: PLOT_WIDTH,
			bottom: PLOT_HEIGHT,
			width: PLOT_WIDTH,
			height: PLOT_HEIGHT,
			toJSON: () => ({}),
		}) as DOMRect;
}

function plot(): SVGSVGElement {
	const svg = host?.querySelector("svg");
	if (!svg) throw new Error("plot not rendered");
	return svg as SVGSVGElement;
}

function selectedLink(): HTMLAnchorElement | null {
	const links = Array.from(host?.querySelectorAll("a") ?? []);
	return (links.find((a) => a.textContent?.includes("Open selected request")) ??
		null) as HTMLAnchorElement | null;
}

async function mount() {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<ScrollingLanes
				plotAreaRef={createRef<HTMLDivElement>()}
				lanes={lanes}
				renderNow={T0}
				windowMs={WINDOW}
				setWindowMs={() => {}}
				plotWidth={PLOT_WIDTH}
				connected={true}
				outages={[]}
				coverageFrom={T0 - WINDOW}
				primed={true}
				reducedMotion={true}
			/>,
		);
	});
	stubPlotRect(plot());
}

/** Put a cursor on the most recent mark the way a keyboard user would. */
async function focusPlot() {
	await act(async () => {
		plot().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
	});
}

beforeEach(() => {
	opened = [];
	realOpen = window.open;
	window.open = ((url?: string | URL) => {
		opened.push(String(url));
		return null;
	}) as typeof window.open;
});

afterEach(async () => {
	window.open = realOpen;
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
});

async function clickPlot(clientX: number, clientY: number) {
	await act(async () => {
		plot().dispatchEvent(
			new MouseEvent("click", { bubbles: true, clientX, clientY }),
		);
	});
}

describe("Live Activity plot — clicking a mark", () => {
	it("opens the request under the pointer in a new tab", async () => {
		await mount();
		await clickPlot(xOfTs(T0 - 5_000), LANE_HEIGHT / 2);

		expect(opened).toEqual(["/requests?request=recent"]);
	});

	it("still opens a mark the pointer only came close to", async () => {
		await mount();
		await clickPlot(xOfTs(T0 - 5_000) - 5, LANE_HEIGHT / 2);

		expect(opened).toEqual(["/requests?request=recent"]);
	});

	it("opens nothing when the click lands on empty space in a busy lane", async () => {
		await mount();
		// Halfway between the two marks. Nearest-mark alone would open one of
		// them, minutes away from where the pointer actually is.
		await clickPlot(
			(xOfTs(T0 - 5_000) + xOfTs(T0 - 150_000)) / 2,
			LANE_HEIGHT / 2,
		);

		expect(opened).toEqual([]);
	});

	it("opens nothing when the click is below the last lane", async () => {
		await mount();
		await clickPlot(xOfTs(T0 - 5_000), LANE_HEIGHT * 8);

		expect(opened).toEqual([]);
	});
});

describe("Live Activity plot — keyboard", () => {
	it("selects a mark on focus and reveals a real link to it", async () => {
		await mount();
		expect(selectedLink()).toBeNull();

		await focusPlot();

		const link = selectedLink();
		// The most recent mark of the first non-empty lane, so Enter always has
		// a target rather than needing an arrow key to be guessed first.
		expect(link?.getAttribute("href")).toBe("/requests?request=recent");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("opens the selected request on Enter", async () => {
		await mount();
		await focusPlot();

		await act(async () => {
			plot().dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});

		expect(opened).toEqual(["/requests?request=recent"]);
	});

	it("swallows Space so the page does not scroll instead", async () => {
		await mount();
		await focusPlot();

		let defaultPrevented = false;
		await act(async () => {
			const keyEvent = new KeyboardEvent("keydown", {
				key: " ",
				bubbles: true,
				cancelable: true,
			});
			plot().dispatchEvent(keyEvent);
			defaultPrevented = keyEvent.defaultPrevented;
		});

		expect(defaultPrevented).toBe(true);
		expect(opened).toEqual(["/requests?request=recent"]);
	});

	it("keeps the selection while focus moves from the plot to that link", async () => {
		await mount();
		await focusPlot();
		const link = selectedLink();
		expect(link).not.toBeNull();

		await act(async () => {
			plot().dispatchEvent(
				new FocusEvent("focusout", { bubbles: true, relatedTarget: link }),
			);
		});

		// Clearing here would unmount the link mid-tab, leaving focus nowhere.
		expect(selectedLink()).not.toBeNull();
	});

	it("clears the selection when focus leaves the plot area entirely", async () => {
		await mount();
		await focusPlot();
		expect(selectedLink()).not.toBeNull();

		const outside = document.createElement("button");
		document.body.appendChild(outside);
		await act(async () => {
			plot().dispatchEvent(
				new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
			);
		});

		expect(selectedLink()).toBeNull();
		outside.remove();
	});
});
