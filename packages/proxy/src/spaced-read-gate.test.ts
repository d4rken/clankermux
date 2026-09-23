import { describe, expect, it } from "bun:test";
import { ReadGateStoppedError, SpacedReadGate } from "./spaced-read-gate";

function gate(options: { jitter?: number } = {}) {
	let clock = 0;
	const sleeps: number[] = [];
	const g = new SpacedReadGate({
		spacingMs: 1000,
		jitter: () => options.jitter ?? 0,
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
	});
	return {
		g,
		sleeps,
		advance: (ms: number) => {
			clock += ms;
		},
		setClock: (ms: number) => {
			clock = ms;
		},
	};
}

async function send(g: SpacedReadGate, accountId: string, urgent = false) {
	const turn = await g.acquire(accountId, { urgent });
	turn.sent();
	turn.release();
}

describe("SpacedReadGate", () => {
	it("holds the next account's request for the rest of the gap after the last one sent", async () => {
		const { g, sleeps, advance } = gate();
		await send(g, "a");
		advance(300);
		await send(g, "b");
		expect(sleeps).toEqual([700]);
	});

	it("never holds a request for the account sent last", async () => {
		const { g, sleeps } = gate();
		await send(g, "a");
		await send(g, "a");
		expect(sleeps).toEqual([]);
	});

	it("leaves the timeline alone when a turn is released unsent", async () => {
		const { g, sleeps, advance } = gate();
		await send(g, "a");
		advance(1000);
		(await g.acquire("b")).release();
		await send(g, "a");
		expect(sleeps).toEqual([]);
	});

	it("holds the next caller until the current turn is released, even once sent", async () => {
		const { g } = gate();
		const first = await g.acquire("a");
		let second = false;
		const waiting = g.acquire("a").then((turn) => {
			second = true;
			turn.release();
		});
		first.sent();
		await Bun.sleep(0);
		expect(second).toBe(false);
		first.release();
		await waiting;
		expect(second).toBe(true);
	});

	it("spaces from the latest sent() of a turn, such as a retry", async () => {
		const { g, sleeps, advance } = gate();
		const turn = await g.acquire("a");
		turn.sent();
		advance(800);
		turn.sent();
		turn.release();
		await send(g, "b");
		expect(sleeps).toEqual([1000]);
	});

	it("rejects the waiting caller and moves on when the wait itself fails", async () => {
		let fail = true;
		const g = new SpacedReadGate({
			spacingMs: 1000,
			jitter: () => 0,
			now: () => 0,
			sleep: async () => {
				if (fail) {
					fail = false;
					throw new Error("timer broke");
				}
			},
		});
		await send(g, "a");
		await expect(g.acquire("b")).rejects.toThrow("timer broke");
		await send(g, "c");
	});

	it("serves urgent callers before waiting background ones", async () => {
		const { g } = gate();
		const order: string[] = [];
		const held = await g.acquire("a");
		const background = g.acquire("b").then((t) => {
			order.push("b");
			t.release();
		});
		const urgent = g.acquire("c", { urgent: true }).then((t) => {
			order.push("c");
			t.release();
		});
		held.release();
		await Promise.all([background, urgent]);
		expect(order).toEqual(["c", "b"]);
	});

	it("widens the gap by the jitter", async () => {
		const { g, sleeps } = gate({ jitter: 0.5 });
		await send(g, "a");
		await send(g, "b");
		expect(sleeps).toEqual([1500]);
	});

	it("caps the wait at one gap when the clock steps backwards", async () => {
		const { g, sleeps, setClock } = gate();
		setClock(1_000_000);
		await send(g, "a");
		setClock(0);
		await send(g, "b");
		expect(sleeps).toEqual([1000]);
	});

	it("refuses new turns and rejects waiting ones once stopped", async () => {
		const { g } = gate();
		const held = await g.acquire("a");
		const waiting = g.acquire("b");
		g.stop();
		await expect(waiting).rejects.toBeInstanceOf(ReadGateStoppedError);
		await expect(g.acquire("c")).rejects.toBeInstanceOf(ReadGateStoppedError);
		held.release();
	});
});
