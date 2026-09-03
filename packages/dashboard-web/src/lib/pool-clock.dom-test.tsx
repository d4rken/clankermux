import { afterEach, describe, expect, it } from "bun:test";
import { act, type ReactNode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { subscribePoolClock } from "./pool-clock";

/**
 * The shared quota clock, and specifically the teardown behaviour that a
 * single-page session can never exercise.
 *
 * The bug this guards against is a silent one. `IntervalManager.register`
 * replaces any interval already holding the same id, and hands back an
 * unregister closure keyed on that id rather than on the registration. So the
 * naive version of this module — two components each calling
 * `registerUIRefresh` with a shared id — survives mounting fine, and breaks the
 * moment ONE of them unmounts: the survivor's interval is gone, its countdowns
 * freeze, and nothing throws. Overview and Usage both being mounted is what it
 * takes to see it.
 *
 * Mounted for real rather than rendered statically, because the whole property
 * is about effect cleanup ordering across two component lifetimes.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Counts the ticks it has received, so a stopped clock is visible. */
function Subscriber({ label }: { label: string }): ReactNode {
	const [ticks, setTicks] = useState(0);
	useEffect(() => subscribePoolClock(() => setTicks((n) => n + 1)), []);
	return <div data-testid={label}>{ticks}</div>;
}

function ticksOf(label: string): number {
	const el = host?.querySelector(`[data-testid="${label}"]`);
	return Number(el?.textContent ?? "-1");
}

async function render(node: ReactNode): Promise<void> {
	await act(async () => {
		root?.render(node);
	});
}

afterEach(async () => {
	if (root) {
		const current = root;
		await act(async () => {
			current.unmount();
		});
	}
	root = null;
	host?.remove();
	host = null;
});

describe("shared pool clock", () => {
	it("keeps ticking for the survivor when one subscriber unmounts", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		// Both pages mounted, as they are when a user has Overview and Usage open.
		await render(
			<>
				<Subscriber label="a" />
				<Subscriber label="b" />
			</>,
		);

		// Both have a reading, and the second one is the point: it mounted after
		// the registration already existed, so it never sees the immediate tick
		// and is served directly on subscribe instead. Without that it would sit
		// on its initial value for a full interval.
		expect(ticksOf("a")).toBeGreaterThan(0);
		expect(ticksOf("b")).toBeGreaterThan(0);

		// One page goes away. Under the shared-id implementation this is where
		// the survivor's interval is destroyed.
		await render(<Subscriber label="b" />);

		// Re-subscribing proves the registration is still live: a torn-down
		// clock would leave the new subscriber on its initial value forever,
		// because nothing would ever call it.
		host.appendChild(document.createElement("div"));
		await render(
			<>
				<Subscriber label="b" />
				<Subscriber label="c" />
			</>,
		);
		expect(ticksOf("c")).toBeGreaterThan(0);
	});

	it("tears the interval down only when the last subscriber leaves", async () => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);

		await render(<Subscriber label="a" />);
		expect(ticksOf("a")).toBeGreaterThan(0);

		// Everything unmounts, then a fresh subscriber arrives. If the last
		// unsubscribe had failed to clear the module-level handle, this
		// registration would be skipped and the new subscriber would never tick.
		await render(<div />);
		await render(<Subscriber label="d" />);
		expect(ticksOf("d")).toBeGreaterThan(0);
	});
});
