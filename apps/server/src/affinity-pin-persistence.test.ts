import { describe, expect, it } from "bun:test";
import type { AffinityPin, LoadBalancingStrategy } from "@clankermux/types";
import {
	AffinityPinPersistence,
	type AffinityPinStore,
} from "./affinity-pin-persistence";

const NOW = 1_800_000_000_000;
const MAX_AGE_MS = 5 * 60 * 60 * 1000;

class FakeStrategy {
	pins: AffinityPin[] = [];
	affinityRevision = 0;
	imports: Array<{ pins: readonly AffinityPin[]; now: number }> = [];
	select() {
		return [];
	}
	peekRanked() {
		return [];
	}
	peek() {
		return null;
	}
	exportAffinity(): AffinityPin[] {
		return [...this.pins];
	}
	importAffinity(pins: readonly AffinityPin[], now: number): void {
		this.imports.push({ pins, now });
		this.pins = [...this.pins, ...pins];
		this.affinityRevision++;
	}
	set(...keys: string[]) {
		this.pins = keys.map((keyHash, i) => ({
			keyHash,
			accountId: "acc",
			lastUsedAt: NOW + i,
		}));
		this.affinityRevision++;
	}
}

const asStrategy = (s: FakeStrategy | object) =>
	s as unknown as LoadBalancingStrategy;

const withoutAffinity = (): LoadBalancingStrategy =>
	asStrategy({ select: () => [], peekRanked: () => [], peek: () => null });

class FakeStore implements AffinityPinStore {
	writes: string[][] = [];
	reads: number[] = [];
	stored: AffinityPin[] = [];
	/** When set, each write waits for the returned gate before landing. */
	gate: (() => Promise<void>) | null = null;
	failWrites = false;
	active = 0;
	maxActive = 0;
	async replaceSessionAffinityPins(pins: readonly AffinityPin[]) {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			const snapshot = pins.map((p) => p.keyHash);
			if (this.gate) await this.gate();
			if (this.failWrites) throw new Error("disk full");
			this.writes.push(snapshot);
			this.stored = [...pins];
		} finally {
			this.active--;
		}
	}
	async getSessionAffinityPins(sinceMs: number) {
		this.reads.push(sinceMs);
		return this.stored.filter((p) => p.lastUsedAt >= sinceMs);
	}
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function make(
	store: FakeStore,
	getStrategy: () => LoadBalancingStrategy | null,
) {
	return new AffinityPinPersistence({
		store,
		getStrategy,
		maxAgeMs: MAX_AGE_MS,
		now: () => NOW,
	});
}

describe("AffinityPinPersistence", () => {
	it("restores pins newer than the session duration into the strategy", async () => {
		const store = new FakeStore();
		store.stored = [
			{ keyHash: "old", accountId: "acc", lastUsedAt: NOW - MAX_AGE_MS - 1 },
			{ keyHash: "live", accountId: "acc", lastUsedAt: NOW - 1 },
		];
		const strategy = new FakeStrategy();
		const persistence = make(store, () => asStrategy(strategy));

		await persistence.restore(asStrategy(strategy));

		expect(store.reads).toEqual([NOW - MAX_AGE_MS]);
		expect(strategy.imports).toEqual([{ pins: [store.stored[1]], now: NOW }]);
		// The first snapshot rewrites the table without the expired row.
		await persistence.snapshot();
		expect(store.writes).toEqual([["live"]]);
	});

	it("skips a snapshot when the revision has not moved since the last write", async () => {
		const store = new FakeStore();
		const strategy = new FakeStrategy();
		const persistence = make(store, () => asStrategy(strategy));

		strategy.set("a");
		await persistence.snapshot();
		await persistence.snapshot();
		strategy.set("a", "b");
		await persistence.snapshot();

		expect(store.writes).toEqual([["a"], ["a", "b"]]);
	});

	it("writes again after a failed write even though the revision is unchanged", async () => {
		const store = new FakeStore();
		const strategy = new FakeStrategy();
		const persistence = make(store, () => asStrategy(strategy));

		strategy.set("a");
		store.failWrites = true;
		await persistence.snapshot();
		store.failWrites = false;
		await persistence.snapshot();

		expect(store.writes).toEqual([["a"]]);
	});

	it("never snapshots a strategy without affinity export", async () => {
		const store = new FakeStore();
		store.stored = [{ keyHash: "kept", accountId: "acc", lastUsedAt: NOW }];
		const persistence = make(store, withoutAffinity);

		await persistence.snapshot();
		await persistence.flushFinal(1_000);

		expect(store.writes).toEqual([]);
		expect(store.stored.map((p) => p.keyHash)).toEqual(["kept"]);
	});

	it("writes a strategy that replaced the last-written one even at an equal revision", async () => {
		const store = new FakeStore();
		const first = new FakeStrategy();
		const second = new FakeStrategy();
		let current = first;
		const persistence = make(store, () => asStrategy(current));

		first.set("a");
		await persistence.snapshot();
		second.set("b");
		current = second;
		await persistence.snapshot();

		expect(store.writes).toEqual([["a"], ["b"]]);
	});

	it("lands the final flush after a slow in-flight snapshot", async () => {
		const store = new FakeStore();
		const strategy = new FakeStrategy();
		const persistence = make(store, () => asStrategy(strategy));
		const slow = deferred();

		strategy.set("stale");
		store.gate = () => slow.promise;
		const inFlight = persistence.snapshot();
		await Bun.sleep(1);
		expect(store.active).toBe(1);

		strategy.set("stale", "final");
		const final = persistence.flushFinal(5_000);
		await Bun.sleep(5);
		expect(store.active).toBe(1);

		slow.resolve();
		await Promise.all([inFlight, final]);

		expect(store.maxActive).toBe(1);
		expect(store.writes).toEqual([["stale"], ["stale", "final"]]);
		expect(store.stored.map((p) => p.keyHash)).toEqual(["stale", "final"]);

		strategy.set("after");
		await persistence.snapshot();
		expect(store.writes).toHaveLength(2);
	});

	it("snapshots on its interval until the final flush stops it", async () => {
		const store = new FakeStore();
		const strategy = new FakeStrategy();
		const persistence = new AffinityPinPersistence({
			store,
			getStrategy: () => asStrategy(strategy),
			maxAgeMs: MAX_AGE_MS,
			intervalMs: 5,
		});

		strategy.set("a");
		persistence.start();
		for (let i = 0; i < 200 && store.writes.length === 0; i++) {
			await Bun.sleep(5);
		}
		await Bun.sleep(20);
		expect(store.writes).toEqual([["a"]]);

		strategy.set("b");
		await persistence.flushFinal(1_000);
		strategy.set("c");
		await Bun.sleep(40);
		expect(store.writes).toEqual([["a"], ["b"]]);
	});

	it("gives up on the final flush after the timeout", async () => {
		const store = new FakeStore();
		const strategy = new FakeStrategy();
		const persistence = make(store, () => asStrategy(strategy));
		const never = deferred();

		strategy.set("a");
		store.gate = () => never.promise;
		const started = performance.now();
		await persistence.flushFinal(30);

		expect(performance.now() - started).toBeLessThan(1_000);
		expect(store.writes).toEqual([]);
	});

	it("drops writes still queued when the final flush timed out", async () => {
		const store = new FakeStore();
		const strategy = new FakeStrategy();
		const persistence = make(store, () => asStrategy(strategy));
		const stuck = deferred();

		strategy.set("a");
		store.gate = () => stuck.promise;
		const inFlight = persistence.snapshot();
		await persistence.flushFinal(30);

		strategy.set("b");
		store.gate = null;
		stuck.resolve();
		await inFlight;
		await Bun.sleep(20);

		expect(store.writes).toEqual([["a"]]);
	});

	describe("adopt", () => {
		it("carries the outgoing strategy's pins into the new one without reading the table", async () => {
			const store = new FakeStore();
			store.stored = [{ keyHash: "table", accountId: "acc", lastUsedAt: NOW }];
			const outgoing = new FakeStrategy();
			outgoing.set("memory");
			const incoming = new FakeStrategy();
			const persistence = make(store, () => asStrategy(incoming));

			await persistence.adopt(asStrategy(outgoing), asStrategy(incoming));

			expect(store.reads).toEqual([]);
			expect(incoming.imports).toEqual([
				{ pins: outgoing.exportAffinity(), now: NOW },
			]);
		});

		it("restores from the table when the outgoing strategy has no pins to hand over", async () => {
			const store = new FakeStore();
			store.stored = [{ keyHash: "table", accountId: "acc", lastUsedAt: NOW }];
			const incoming = new FakeStrategy();
			const persistence = make(store, () => asStrategy(incoming));

			await persistence.adopt(withoutAffinity(), asStrategy(incoming));

			expect(incoming.pins.map((p) => p.keyHash)).toEqual(["table"]);
		});

		it("does nothing for a strategy that cannot import", async () => {
			const store = new FakeStore();
			const outgoing = new FakeStrategy();
			outgoing.set("memory");
			const persistence = make(store, withoutAffinity);

			await persistence.adopt(asStrategy(outgoing), withoutAffinity());

			expect(store.reads).toEqual([]);
			expect(store.writes).toEqual([]);
		});
	});
});
