import { describe, expect, it } from "bun:test";
import { IntervalManager } from "./interval-manager";

/**
 * Regression coverage for the RateLimitProgress countdown-freeze bug.
 *
 * Every account card mounts its own <RateLimitProgress>, and each one registers
 * a 30s "tick" interval to advance its local clock. They used to share a single
 * hard-coded id ("rate-limit-progress-update"). Because the manager replaces any
 * interval whose id already exists, each newly-mounted card silently cancelled
 * the previous card's ticker — so only the last card's countdown stayed live and
 * every other card's "… until refresh" text froze until a full page reload.
 *
 * The fix gives each instance a unique id (React useId()). These tests lock in
 * the manager invariant the fix relies on: identical ids collapse to one live
 * interval, distinct ids each keep their own.
 */
describe("IntervalManager id collision", () => {
	it("replaces a colliding id, leaving only one live interval (the old bug)", () => {
		const manager = new IntervalManager();
		try {
			const firstFired: string[] = [];
			const secondFired: string[] = [];

			// Two "cards" register under the SAME id, as the buggy component did.
			manager.register({
				id: "rate-limit-progress-update",
				callback: () => firstFired.push("first"),
				intervalMs: 30_000,
			});
			manager.register({
				id: "rate-limit-progress-update",
				callback: () => secondFired.push("second"),
				intervalMs: 30_000,
			});

			// Only one interval survives — the second registration evicted the first.
			expect(manager.getActiveCount()).toBe(1);
			expect(manager.has("rate-limit-progress-update")).toBe(true);
			const info = manager.getIntervalInfo();
			expect(info).toHaveLength(1);
		} finally {
			manager.shutdown();
		}
	});

	it("keeps every distinct id alive (the fix: per-instance ids)", () => {
		const manager = new IntervalManager();
		try {
			const ids = [
				"rate-limit-progress-update-:r1:",
				"rate-limit-progress-update-:r2:",
				"rate-limit-progress-update-:r3:",
			];
			for (const id of ids) {
				manager.register({ id, callback: () => {}, intervalMs: 30_000 });
			}

			expect(manager.getActiveCount()).toBe(ids.length);
			for (const id of ids) {
				expect(manager.has(id)).toBe(true);
			}
		} finally {
			manager.shutdown();
		}
	});

	it("isolates per-instance lifecycle: unmounting one card leaves siblings live", () => {
		const manager = new IntervalManager();
		try {
			// Mirror three cards each registering their own ticker and holding the
			// returned cleanup fn (what React runs on unmount).
			const ids = ["card-a", "card-b", "card-c"];
			const cleanups = new Map(
				ids.map((id) => [
					id,
					manager.register({ id, callback: () => {}, intervalMs: 30_000 }),
				]),
			);
			expect(manager.getActiveCount()).toBe(3);

			// One card unmounts. With per-instance ids, only its ticker is removed;
			// the shared singleton must not retain it, and siblings keep ticking.
			cleanups.get("card-b")?.();

			expect(manager.getActiveCount()).toBe(2);
			expect(manager.has("card-b")).toBe(false);
			expect(manager.has("card-a")).toBe(true);
			expect(manager.has("card-c")).toBe(true);
		} finally {
			manager.shutdown();
		}
	});

	it("ticks every distinct id independently over time", async () => {
		const manager = new IntervalManager();
		try {
			const fired = new Map<string, number>();
			const ids = ["card-a", "card-b", "card-c"];
			for (const id of ids) {
				fired.set(id, 0);
				manager.register({
					id,
					// immediate:false so we only count real ticks, not the initial run.
					callback: () => fired.set(id, (fired.get(id) ?? 0) + 1),
					intervalMs: 20,
				});
			}

			// Poll rather than sleeping a single fixed span, so a slow/stalled event
			// loop just waits longer instead of failing spuriously.
			const deadline = Bun.nanoseconds() + 2_000_000_000; // 2s budget
			const allTicked = () => ids.every((id) => (fired.get(id) ?? 0) >= 1);
			while (!allTicked() && Bun.nanoseconds() < deadline) {
				await Bun.sleep(20);
			}

			for (const id of ids) {
				expect(fired.get(id)).toBeGreaterThanOrEqual(1);
			}
		} finally {
			manager.shutdown();
		}
	});
});
