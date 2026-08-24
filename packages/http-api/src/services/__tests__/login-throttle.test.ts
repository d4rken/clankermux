/**
 * Load control on the login endpoint.
 *
 * The thing being protected is this process's CPU, not the account: scrypt runs
 * on the SERVER, so an unauthenticated caller sending logins is spending our
 * threadpool. The two limiters answer different questions and are asserted
 * separately — peak concurrency, and sustained rate.
 */
import { describe, expect, it } from "bun:test";
import { LoginThrottle } from "../login-throttle";

describe("token bucket", () => {
	it("admits a burst up to capacity, then refuses", () => {
		const t = new LoginThrottle(3, 1_000, 10, () => 0);
		for (let i = 0; i < 3; i++) {
			const claim = t.tryAcquire();
			expect(claim.ok).toBe(true);
			if (claim.ok) claim.release();
		}
		const refused = t.tryAcquire();
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.rejection.reason).toBe("rate_limited");
	});

	it("suggests a whole-second Retry-After", () => {
		const t = new LoginThrottle(1, 5_000, 10, () => 0);
		const first = t.tryAcquire();
		if (first.ok) first.release();
		const refused = t.tryAcquire();
		expect(refused.ok).toBe(false);
		if (!refused.ok) {
			expect(refused.rejection.retryAfterSeconds).toBeGreaterThanOrEqual(1);
			expect(refused.rejection.retryAfterSeconds).toBeLessThanOrEqual(5);
		}
	});

	it("refills one attempt per interval and never past capacity", () => {
		let now = 0;
		const t = new LoginThrottle(2, 1_000, 10, () => now);
		for (let i = 0; i < 2; i++) {
			const c = t.tryAcquire();
			if (c.ok) c.release();
		}
		expect(t.tryAcquire().ok).toBe(false);
		now = 1_000;
		const one = t.tryAcquire();
		expect(one.ok).toBe(true);
		if (one.ok) one.release();
		expect(t.tryAcquire().ok).toBe(false);

		// A long idle period cannot bank more than capacity.
		now = 1_000_000;
		for (let i = 0; i < 2; i++) {
			const c = t.tryAcquire();
			expect(c.ok).toBe(true);
			if (c.ok) c.release();
		}
		expect(t.tryAcquire().ok).toBe(false);
	});

	it("does not discard the fraction of an interval that has not yet earned a token", () => {
		let now = 0;
		const t = new LoginThrottle(1, 1_000, 10, () => now);
		const first = t.tryAcquire();
		if (first.ok) first.release();
		// Repeated probes inside one interval must not keep resetting the clock,
		// or the bucket would never refill under steady polling.
		for (now = 100; now < 1_000; now += 100) {
			expect(t.tryAcquire().ok).toBe(false);
		}
		now = 1_000;
		expect(t.tryAcquire().ok).toBe(true);
	});
});

describe("concurrency semaphore", () => {
	it("refuses a derivation beyond the concurrent limit", () => {
		const t = new LoginThrottle(100, 1_000, 2, () => 0);
		const a = t.tryAcquire();
		const b = t.tryAcquire();
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		const c = t.tryAcquire();
		expect(c.ok).toBe(false);
		if (!c.ok) expect(c.rejection.reason).toBe("busy");
	});

	it("does not charge a token for an attempt that never ran", () => {
		const t = new LoginThrottle(3, 1_000, 1, () => 0);
		const held = t.tryAcquire();
		expect(held.ok).toBe(true);
		// Two refusals on concurrency alone.
		expect(t.tryAcquire().ok).toBe(false);
		expect(t.tryAcquire().ok).toBe(false);
		if (held.ok) held.release();
		// Two tokens must remain — the refused attempts spent none.
		const one = t.tryAcquire();
		expect(one.ok).toBe(true);
		if (one.ok) one.release();
		const two = t.tryAcquire();
		expect(two.ok).toBe(true);
		if (two.ok) two.release();
		expect(t.tryAcquire().ok).toBe(false);
	});

	it("frees the slot again after release, and release is idempotent", () => {
		const t = new LoginThrottle(100, 1_000, 1, () => 0);
		const a = t.tryAcquire();
		expect(a.ok).toBe(true);
		if (a.ok) {
			a.release();
			a.release();
		}
		const b = t.tryAcquire();
		expect(b.ok).toBe(true);
		// A double release must not have inflated the pool.
		if (b.ok) {
			expect(t.tryAcquire().ok).toBe(false);
		}
	});
});
