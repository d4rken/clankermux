import { describe, expect, test } from "bun:test";
import {
	type CdpClient,
	type CdpParams,
	type CdpResult,
	clickSelector,
	type PageSession,
} from "./client";

/** One reply to the click-point probe, in the shape the page returns. */
interface Probe {
	x: number;
	y: number;
	width: number;
	height: number;
	reaches: "target" | "covered" | "outside";
	covering: string | null;
}

const at = (x: number, y: number): Probe => ({
	x,
	y,
	width: 100,
	height: 40,
	reaches: "target",
	covering: null,
});

const coveredAt = (x: number, y: number): Probe => ({
	...at(x, y),
	reaches: "covered",
	covering: "div.fixed.inset-0.z-50",
});

/**
 * A page that answers the expressions {@link clickSelector} evaluates and
 * records the mouse events it dispatches.
 *
 * `probes` is consumed one reply per probe and the last entry repeats, which is
 * how a point that never clears is expressed.
 */
function stubPage(probes: Probe[]): {
	page: PageSession;
	dispatched: CdpParams[];
	probeCount: () => number;
} {
	const dispatched: CdpParams[] = [];
	let taken = 0;
	const send = (method: string, params: CdpParams = {}): Promise<CdpResult> => {
		if (method === "Input.dispatchMouseEvent") {
			dispatched.push(params);
			return Promise.resolve({});
		}
		if (method !== "Runtime.evaluate")
			throw new Error(`Unexpected CDP command ${method}`);
		// The existence wait comes first and is not a probe.
		if (String(params.expression).startsWith("!!document.querySelector"))
			return Promise.resolve({ result: { value: true } });
		const probe = probes[Math.min(taken, probes.length - 1)];
		taken += 1;
		return Promise.resolve({ result: { value: probe } });
	};
	const page = {
		client: { send } as unknown as CdpClient,
		sessionId: "stub",
		tracker: null,
		initScriptId: null,
	} as unknown as PageSession;
	return { page, dispatched, probeCount: () => taken };
}

describe("clickSelector", () => {
	test("clicks the centre once the point belongs to the target", async () => {
		const { page, dispatched } = stubPage([at(120, 480)]);
		await clickSelector(page, "button");
		expect(dispatched.map((event) => event.type)).toEqual([
			"mousePressed",
			"mouseReleased",
		]);
		expect(
			dispatched.every((event) => event.x === 120 && event.y === 480),
		).toBe(true);
	});

	test("waits for a covering overlay to go away before clicking", async () => {
		const { page, dispatched, probeCount } = stubPage([
			coveredAt(120, 480),
			coveredAt(120, 480),
			at(120, 300),
		]);
		await clickSelector(page, "button");
		expect(probeCount()).toBe(3);
		// The coordinates come from the probe that cleared, not the first one.
		expect(dispatched.map((event) => event.y)).toEqual([300, 300]);
	});

	test("dispatches nothing while the point stays covered", async () => {
		const { page, dispatched } = stubPage([coveredAt(120, 480)]);
		await expect(clickSelector(page, "button", 150)).rejects.toThrow(
			/div\.fixed\.inset-0\.z-50 covers its centre \(120, 480\)/,
		);
		expect(dispatched).toEqual([]);
	});

	test("dispatches nothing when the target has no layout box", async () => {
		const { page, dispatched } = stubPage([{ ...at(0, 0), width: 0 }]);
		await expect(clickSelector(page, "button", 150)).rejects.toThrow(
			/no layout box/,
		);
		expect(dispatched).toEqual([]);
	});
});
