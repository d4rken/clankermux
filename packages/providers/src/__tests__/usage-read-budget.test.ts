import { describe, expect, it } from "bun:test";
import { UsageReadBudget } from "../usage-read-budget";

const GAP = 150_000;
const HOUR = 60 * 60 * 1000;

function clock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

function budget(c = clock(), onRead?: (id: string, at: number) => void) {
	return new UsageReadBudget({ gapMs: GAP, now: c.now, onRead });
}

function commitNow(b: UsageReadBudget, id: string): void {
	const grant = b.tryAcquire(id);
	if (!("slot" in grant)) throw new Error("expected a slot");
	grant.slot.commit();
}

describe("UsageReadBudget", () => {
	it("grants the first read and makes the next wait out the gap from the commit", () => {
		const c = clock();
		const b = budget(c);
		commitNow(b, "a");

		c.advance(40_000);
		expect(b.tryAcquire("a")).toEqual({ waitMs: GAP - 40_000 });
		c.advance(GAP - 40_000);
		expect("slot" in b.tryAcquire("a")).toBe(true);
	});

	it("keeps accounts independent", () => {
		const b = budget();
		commitNow(b, "a");
		expect("slot" in b.tryAcquire("b")).toBe(true);
	});

	it("refuses a second caller while a slot is held, and a cancelled slot consumes nothing", () => {
		const b = budget();
		const held = b.tryAcquire("a");
		expect(b.tryAcquire("a")).toEqual({ waitMs: GAP });
		if ("slot" in held) held.slot.cancel();
		expect("slot" in b.tryAcquire("a")).toBe(true);
	});

	it("counts only the first of commit/cancel", () => {
		const reads: number[] = [];
		const c = clock();
		const b = budget(c, (_id, at) => reads.push(at));
		const grant = b.tryAcquire("a");
		if (!("slot" in grant)) throw new Error("expected a slot");
		grant.slot.commit();
		c.advance(1);
		grant.slot.commit();
		grant.slot.cancel();
		expect(reads).toEqual([c.now() - 1]);
		expect(b.lastReadAt("a")).toBe(c.now() - 1);
	});

	it("a recorded read goes out regardless and pushes the next admitted read a full gap back", () => {
		const reads: number[] = [];
		const c = clock();
		const b = budget(c, (_id, at) => reads.push(at));
		commitNow(b, "a");
		c.advance(40_000);

		b.recordRead("a");
		expect(reads).toEqual([c.now() - 40_000, c.now()]);
		expect(b.tryAcquire("a")).toEqual({ waitMs: GAP });
	});

	it("a read recorded while a slot is out still counts, and the slot's commit counts too", () => {
		const c = clock();
		const b = budget(c);
		const grant = b.tryAcquire("a");
		if (!("slot" in grant)) throw new Error("expected a slot");
		b.recordRead("a");
		c.advance(5_000);
		grant.slot.commit();
		expect(b.lastReadAt("a")).toBe(c.now());
		expect(b.tryAcquire("a")).toEqual({ waitMs: GAP });
	});

	it("counts a read stamped in the future as sent now, so reads resume one gap later", () => {
		const c = clock();
		const b = budget(c);
		b.seed("a", c.now() + 10 * GAP);
		expect(b.tryAcquire("a")).toEqual({ waitMs: GAP });
		c.advance(GAP);
		expect("slot" in b.tryAcquire("a")).toBe(true);
	});

	it("resumes one gap after the clock steps back past an in-process read", () => {
		const c = clock();
		const b = budget(c);
		commitNow(b, "a");
		c.advance(-HOUR);
		expect(b.tryAcquire("a")).toEqual({ waitMs: GAP });
		c.advance(GAP);
		expect("slot" in b.tryAcquire("a")).toBe(true);
	});

	it("waitMs peeks without taking a slot", () => {
		const c = clock();
		const b = budget(c);
		expect(b.waitMs("a")).toBe(0);
		const grant = b.tryAcquire("a");
		expect(b.waitMs("a")).toBe(GAP);
		if ("slot" in grant) grant.slot.commit();
		c.advance(40_000);
		expect(b.waitMs("a")).toBe(GAP - 40_000);
		expect("slot" in b.tryAcquire("a")).toBe(false);
	});

	it("seed starts the gap from a persisted read and never moves a later one back", () => {
		const c = clock();
		const b = budget(c);
		b.seed("a", c.now() - 100_000);
		expect(b.tryAcquire("a")).toEqual({ waitMs: 50_000 });
		b.seed("a", c.now() - 140_000);
		expect(b.tryAcquire("a")).toEqual({ waitMs: 50_000 });
	});

	it("clear forgets every account", () => {
		const b = budget();
		commitNow(b, "a");
		b.clear();
		expect("slot" in b.tryAcquire("a")).toBe(true);
	});
});
