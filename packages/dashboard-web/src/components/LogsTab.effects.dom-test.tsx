import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, type LogEntry } from "../api";
import { queryKeys } from "../lib/query-keys";
import { LogsTab } from "./LogsTab";

/**
 * LogsTab's defects live in EFFECT LIFECYCLES, not in rendered output: an
 * `EventSource` torn down by a dependency array, a state reset fired by a
 * re-running effect. `renderToStaticMarkup` — how the rest of this package is
 * tested — never runs effects, so these need a real DOM and a real mount.
 *
 * `.dom-test.tsx`, so plain `bun test` does not collect it: this file runs in
 * the DOM lane (`bun run test:dom`), whose `--preload` installs the DOM globals
 * before any test module evaluates (see test-utils/happy-dom.ts).
 *
 * The stream has NO REPLAY. Anything the component drops while reconnecting or
 * resetting is gone for good, which is why "an EventSource is open" is not a
 * sufficient assertion: it has to be the SAME one.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Stands in for the SSE connection; the test pushes events into it. */
class FakeEventSource {
	static instances: FakeEventSource[] = [];
	closed = false;

	constructor(readonly onLog: (log: LogEntry) => void) {
		FakeEventSource.instances.push(this);
	}

	close(): void {
		this.closed = true;
	}
}

function entry(msg: string): LogEntry {
	return { ts: 1_700_000_000_000, level: "INFO", msg };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let queryClient: QueryClient | null = null;

/** Let React flush effects and the 0ms scroll timeout. */
async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
}

async function mount(history: LogEntry[]): Promise<void> {
	// Each call returns a LONGER history, as a real refetch of a growing server
	// buffer would. React Query shares structurally equal results, so returning
	// an identical copy would keep the same reference and the hydration effect
	// would never see a change — which is not what a live server does.
	let refetches = 0;
	spyOn(api, "getLogHistory").mockImplementation(async () => {
		const grown = [...history];
		for (let i = 0; i < refetches; i++) {
			grown.push(entry(`history-refetch-${i}`));
		}
		refetches++;
		return grown;
	});
	spyOn(api, "streamLogs").mockImplementation(
		(onLog: (log: LogEntry) => void) =>
			new FakeEventSource(onLog) as unknown as EventSource,
	);

	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient as QueryClient}>
				<LogsTab />
			</QueryClientProvider>,
		);
	});
	await settle();
}

function stream(): FakeEventSource {
	const live = FakeEventSource.instances.at(-1);
	if (!live) throw new Error("no EventSource was opened");
	return live;
}

async function emit(msg: string): Promise<void> {
	await act(async () => {
		stream().onLog(entry(msg));
	});
	await settle();
}

async function toggleAutoScroll(): Promise<void> {
	const box = host?.querySelector("#autoscroll") as HTMLInputElement | null;
	if (!box) throw new Error("auto-scroll checkbox not found");
	await act(async () => {
		box.click();
	});
	await settle();
}

function renderedText(): string {
	return host?.textContent ?? "";
}

afterEach(async () => {
	if (root) {
		const current = root;
		await act(async () => {
			current.unmount();
		});
	}
	host?.remove();
	root = null;
	host = null;
	queryClient = null;
	FakeEventSource.instances = [];
});

describe("LogsTab live stream", () => {
	it("keeps the SAME EventSource open when auto-scroll is toggled", async () => {
		// `startStreaming` used to close over `autoScroll`, so every toggle closed
		// and reopened the connection — and the endpoint has no replay, so every
		// line emitted in the gap was lost silently.
		await mount([]);
		expect(FakeEventSource.instances).toHaveLength(1);
		const original = stream();

		await toggleAutoScroll();
		await toggleAutoScroll();

		expect(FakeEventSource.instances).toHaveLength(1);
		expect(stream()).toBe(original);
		expect(original.closed).toBe(false);
	});

	it("keeps the accumulated live lines when auto-scroll is toggled", async () => {
		// The history effect listed `autoScroll` and called `setLogs(history)`, so
		// a toggle rewound the list to the mount-time snapshot.
		await mount([entry("from-history")]);
		await emit("live-one");
		await emit("live-two");

		expect(renderedText()).toContain("live-one");
		expect(renderedText()).toContain("live-two");

		await toggleAutoScroll();

		expect(renderedText()).toContain("from-history");
		expect(renderedText()).toContain("live-one");
		expect(renderedText()).toContain("live-two");
	});

	it("keeps live lines when the history query refetches", async () => {
		// Every refetch produced a NEW array identity, which re-fired the
		// hydration effect and wiped the tail — narrowing the deps alone did not
		// fix it, which is why hydration is guarded to once per mount.
		await mount([entry("from-history")]);
		await emit("live-one");

		await act(async () => {
			await queryClient?.refetchQueries({ queryKey: queryKeys.logHistory() });
		});
		await settle();

		expect(renderedText()).toContain("from-history");
		expect(renderedText()).toContain("live-one");
	});
});

describe("LogsTab auto-scroll behaviour", () => {
	it("never scrolls while auto-scroll is off, and resumes when it is back on", async () => {
		await mount([]);
		const scrollIntoView = spyOn(
			globalThis.HTMLElement.prototype,
			"scrollIntoView",
		).mockImplementation(() => {});

		// Off: an arriving line must not move the viewport.
		await toggleAutoScroll();
		scrollIntoView.mockClear();
		await emit("while-off");
		expect(scrollIntoView).toHaveBeenCalledTimes(0);

		// Back on: jump to the bottom once, so the user isn't left mid-buffer.
		await toggleAutoScroll();
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		// And subsequent lines scroll again.
		await emit("while-on");
		expect(scrollIntoView).toHaveBeenCalledTimes(2);

		scrollIntoView.mockRestore();
	});

	it("does not run a scroll that was scheduled just before auto-scroll went off", async () => {
		// The stream is no longer torn down on toggle, so `stopStreaming()` no
		// longer clears the pending 0ms timeout on the way out. Unlike the other
		// tests here this one also passed BEFORE the fix — the teardown cleared
		// the timeout as a side effect — so it guards the replacement mechanism
		// (the ref re-check inside the timeout) rather than reproducing a defect.
		await mount([]);
		const scrollIntoView = spyOn(
			globalThis.HTMLElement.prototype,
			"scrollIntoView",
		).mockImplementation(() => {});
		scrollIntoView.mockClear();

		// Emit and untick within the same tick, before the timeout can fire.
		await act(async () => {
			stream().onLog(entry("racing"));
			const box = host?.querySelector("#autoscroll") as HTMLInputElement;
			box.click();
		});
		await settle();

		// Only the toggle's own scroll-to-bottom is absent too (it went OFF), so
		// nothing scrolled at all.
		expect(scrollIntoView).toHaveBeenCalledTimes(0);

		scrollIntoView.mockRestore();
	});
});
