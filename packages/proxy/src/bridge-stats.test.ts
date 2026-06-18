import { beforeEach, describe, expect, it } from "bun:test";
import { bridgeStats } from "./bridge-stats";

describe("bridgeStats", () => {
	beforeEach(() => {
		bridgeStats.reset();
	});

	it("starts at zero", () => {
		const s = bridgeStats.snapshot();
		expect(s).toEqual({
			keepalivesSent: 0,
			hits: 0,
			misses: 0,
			failures: 0,
			warmResumes: 0,
			spentUsd: 0,
			savedUsd: 0,
			netUsd: 0,
			hitRate: 0,
		});
	});

	it("counts hits and misses and accumulates spend", () => {
		bridgeStats.recordResult(true, 0.01);
		bridgeStats.recordResult(true, 0.02);
		bridgeStats.recordResult(false, 0.5);
		const s = bridgeStats.snapshot();
		expect(s.keepalivesSent).toBe(3);
		expect(s.hits).toBe(2);
		expect(s.misses).toBe(1);
		expect(s.spentUsd).toBeCloseTo(0.53, 10);
	});

	it("computes hitRate as hits/(hits+misses)", () => {
		bridgeStats.recordResult(true, 0.01);
		bridgeStats.recordResult(true, 0.01);
		bridgeStats.recordResult(true, 0.01);
		bridgeStats.recordResult(false, 0.5);
		expect(bridgeStats.snapshot().hitRate).toBeCloseTo(0.75, 10);
	});

	it("hitRate is 0 when nothing decided", () => {
		bridgeStats.recordFailure();
		expect(bridgeStats.snapshot().hitRate).toBe(0);
	});

	it("counts failures independently of decided keepalives", () => {
		bridgeStats.recordFailure();
		bridgeStats.recordFailure();
		const s = bridgeStats.snapshot();
		expect(s.failures).toBe(2);
		expect(s.keepalivesSent).toBe(0);
		expect(s.hits).toBe(0);
		expect(s.misses).toBe(0);
	});

	it("records warm resumes and savedUsd", () => {
		bridgeStats.recordWarmResume(0.4);
		bridgeStats.recordWarmResume(0.6);
		const s = bridgeStats.snapshot();
		expect(s.warmResumes).toBe(2);
		expect(s.savedUsd).toBeCloseTo(1.0, 10);
	});

	it("net = saved - spent", () => {
		bridgeStats.recordResult(true, 0.1);
		bridgeStats.recordResult(false, 0.3);
		bridgeStats.recordWarmResume(1.0);
		const s = bridgeStats.snapshot();
		expect(s.spentUsd).toBeCloseTo(0.4, 10);
		expect(s.savedUsd).toBeCloseTo(1.0, 10);
		expect(s.netUsd).toBeCloseTo(0.6, 10);
	});

	it("clamps negative and NaN cost to 0", () => {
		bridgeStats.recordResult(true, -5);
		bridgeStats.recordResult(false, Number.NaN);
		bridgeStats.recordResult(true, Number.POSITIVE_INFINITY);
		const s = bridgeStats.snapshot();
		expect(s.keepalivesSent).toBe(3);
		expect(s.hits).toBe(2);
		expect(s.misses).toBe(1);
		expect(s.spentUsd).toBe(0);
	});

	it("clamps negative and NaN savedUsd to 0", () => {
		bridgeStats.recordWarmResume(-1);
		bridgeStats.recordWarmResume(Number.NaN);
		const s = bridgeStats.snapshot();
		expect(s.warmResumes).toBe(2);
		expect(s.savedUsd).toBe(0);
	});

	it("reset clears all counters", () => {
		bridgeStats.recordResult(true, 0.1);
		bridgeStats.recordResult(false, 0.3);
		bridgeStats.recordFailure();
		bridgeStats.recordWarmResume(0.5);
		bridgeStats.reset();
		expect(bridgeStats.snapshot()).toEqual({
			keepalivesSent: 0,
			hits: 0,
			misses: 0,
			failures: 0,
			warmResumes: 0,
			spentUsd: 0,
			savedUsd: 0,
			netUsd: 0,
			hitRate: 0,
		});
	});
});
