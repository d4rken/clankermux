import { describe, expect, it } from "bun:test";
import type { PacingSnapshot } from "../pacing-scan";
import { createPublicPacingReaderFromScan } from "../public-pacing";

/**
 * The memo in front of `GET /public/v1/pacing`.
 *
 * Worth its own suite because the thing it guards is expensive and the surface
 * is unauthenticated: the scan builds the entire account list — session-stats
 * SQL, snapshots, prediction regressions, duplicate detection — deliberately,
 * so pacing cannot drift from the bars beside it. Without the memo an anonymous
 * poll loop on the LAN decides how often that is paid for.
 */

const NOW = 1_700_000_000_000;

function snapshot(generatedAtMs: number): PacingSnapshot {
	return {
		generatedAtMs,
		bindingClassId: null,
		classes: [],
		fiveHour: {
			waiting: 0,
			runningHot: 0,
			room: 0,
			nextLiftMs: null,
			nextLiftAccountName: null,
			classes: [],
			outlook: { label: "No reading", tone: "neutral" },
		},
	};
}

describe("public pacing reader memo", () => {
	it("serves a cached answer inside the TTL without rescanning", async () => {
		let scans = 0;
		let clock = NOW;
		const read = createPublicPacingReaderFromScan(
			async (nowMs) => {
				scans++;
				return snapshot(nowMs);
			},
			{ now: () => clock, ttlMs: 60_000 },
		);

		await read();
		clock = NOW + 59_000;
		const second = await read();

		expect(scans).toBe(1);
		// The READ's own clock, not the request's: a client seeing the same
		// `generatedAt` twice is looking at the same measurement twice, which is
		// the truth.
		expect(second.generatedAtMs).toBe(NOW);
	});

	it("rescans once the TTL has passed", async () => {
		let scans = 0;
		let clock = NOW;
		const read = createPublicPacingReaderFromScan(
			async (nowMs) => {
				scans++;
				return snapshot(nowMs);
			},
			{ now: () => clock, ttlMs: 60_000 },
		);

		await read();
		clock = NOW + 60_001;
		const second = await read();

		expect(scans).toBe(2);
		expect(second.generatedAtMs).toBe(NOW + 60_001);
	});

	it("collapses concurrent callers onto one scan", async () => {
		let scans = 0;
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = createPublicPacingReaderFromScan(
			async (nowMs) => {
				scans++;
				await gate;
				return snapshot(nowMs);
			},
			{ now: () => NOW, ttlMs: 60_000 },
		);

		// Started BEFORE the first resolves, so neither can be served from cache —
		// the single-flight check is the only thing that can stop the second from
		// starting its own account build.
		const both = Promise.all([read(), read(), read()]);
		release?.();
		await both;

		expect(scans).toBe(1);
	});

	it("does not pin a failed scan onto every later caller", async () => {
		let scans = 0;
		let shouldFail = true;
		const read = createPublicPacingReaderFromScan(
			async (nowMs) => {
				scans++;
				if (shouldFail) throw new Error("account read failed");
				return snapshot(nowMs);
			},
			{ now: () => NOW, ttlMs: 60_000 },
		);

		await expect(read()).rejects.toThrow("account read failed");
		// The in-flight promise is cleared in a `finally`, so the next caller gets
		// a fresh attempt. Left set, a single transient DB error would be replayed
		// to every subsequent request until the process restarted.
		shouldFail = false;
		const recovered = await read();

		expect(scans).toBe(2);
		expect(recovered.generatedAtMs).toBe(NOW);
	});
});
