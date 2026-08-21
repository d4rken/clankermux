import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DEFAULT_PALETTE,
	PALETTES,
	ThemeProvider,
	useTheme,
} from "./theme-context";

/**
 * The theme system has TWO independent axes — palette (visual direction) and
 * mode (light/dark/system) — and both are applied to `document.documentElement`
 * as a side effect. Nothing about that is observable from rendered markup, so
 * these need a real DOM and a real mount rather than the package's usual
 * `renderToStaticMarkup`.
 *
 * `.dom-test.tsx`, so plain `bun test` does not collect it: it runs in the DOM
 * lane (`bun run test:dom`), whose `--preload` installs the DOM globals before
 * any test module evaluates.
 *
 * The invariant these guard is that the axes stay independent. A palette change
 * must not disturb the mode class and a mode change must not disturb the
 * palette attribute — get that wrong and switching direction silently throws
 * the user back to light mode.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Handle onto the context, captured by a probe component during render. */
let ctx: ReturnType<typeof useTheme> | null = null;

function Probe() {
	ctx = useTheme();
	return null;
}

let container: HTMLDivElement;
let root: Root;

function mount() {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root.render(
			<ThemeProvider>
				<Probe />
			</ThemeProvider>,
		);
	});
}

const html = () => document.documentElement;

beforeEach(() => {
	localStorage.clear();
	html().className = "";
	html().removeAttribute("data-palette");
	// Deterministic starting point: without a matchMedia stub, "system" resolves
	// against whatever happy-dom reports, which is not what these assert on.
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	ctx = null;
});

describe("ThemeProvider palette axis", () => {
	it("defaults to the classic palette when nothing is stored", () => {
		mount();
		expect(ctx?.palette).toBe(DEFAULT_PALETTE);
		expect(html().getAttribute("data-palette")).toBe(DEFAULT_PALETTE);
	});

	it("applies a stored palette on first paint", () => {
		localStorage.setItem("palette", "foundry");
		mount();
		expect(ctx?.palette).toBe("foundry");
		expect(html().getAttribute("data-palette")).toBe("foundry");
	});

	it("falls back to the default for an unknown stored palette", () => {
		// A palette removed after the decision would otherwise leave the app with
		// data-palette="retired" and no token block behind it — every colour would
		// resolve to whatever :root happens to hold.
		localStorage.setItem("palette", "retired-direction");
		mount();
		expect(ctx?.palette).toBe(DEFAULT_PALETTE);
		expect(html().getAttribute("data-palette")).toBe(DEFAULT_PALETTE);
	});

	it("persists a palette change", () => {
		mount();
		act(() => ctx?.setPalette("signal"));
		expect(html().getAttribute("data-palette")).toBe("signal");
		expect(localStorage.getItem("palette")).toBe("signal");
	});

	it("keeps the mode class when the palette changes", () => {
		localStorage.setItem("theme", "dark");
		mount();
		expect(html().classList.contains("dark")).toBe(true);

		act(() => ctx?.setPalette("paper"));

		expect(html().classList.contains("dark")).toBe(true);
		expect(html().getAttribute("data-palette")).toBe("paper");
	});

	it("keeps the palette attribute when the mode changes", () => {
		localStorage.setItem("palette", "signal");
		mount();

		act(() => ctx?.setTheme("dark"));

		expect(html().getAttribute("data-palette")).toBe("signal");
		expect(html().classList.contains("dark")).toBe(true);
	});

	it("exposes every palette with a label", () => {
		// The picker renders from this list, so a palette added to the CSS without
		// an entry here is unreachable in the UI.
		expect(PALETTES.map((p) => p.id)).toEqual([
			"classic",
			"signal",
			"foundry",
			"paper",
			"ledger",
			"blueprint",
			"tape",
		]);
		for (const palette of PALETTES) {
			expect(palette.label.length).toBeGreaterThan(0);
			expect(palette.description.length).toBeGreaterThan(0);
		}
	});
});

describe("ThemeProvider mode axis", () => {
	it("still resolves system to a concrete class", () => {
		mount();
		expect(ctx?.theme).toBe("system");
		expect(html().classList.contains("light")).toBe(true);
	});

	it("replaces rather than accumulates mode classes", () => {
		mount();
		act(() => ctx?.setTheme("dark"));
		act(() => ctx?.setTheme("light"));
		expect(html().classList.contains("dark")).toBe(false);
		expect(html().classList.contains("light")).toBe(true);
	});
});
