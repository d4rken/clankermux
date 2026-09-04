import { describe, expect, it } from "bun:test";
import { createPublicWorkloadHeadroomReaderFromScan } from "../public-workload-headroom";
import type { WorkloadHeadroomSnapshot } from "../workload-headroom-scan";

/**
 * The memo in front of `GET /public/v1/workload-headroom`.
 *
 * Worth its own suite for a sharper version of the pacing reader's reason. The
 * scan underneath is the full runway resolution, and then EVERY row runs a pace
 * probe of up to 50 pool rebuilds on top of it. The surface is unauthenticated,
 * so without the memo an anonymous poll loop on the LAN decides how often that
 * is paid for.
 */

const NOW = 1_700_000_000_000;

function snapshot(generatedAtMs: number): WorkloadHeadroomSnapshot {
	return { generatedAtMs, horizonMs: 1_209_600_000, rows: [] };
}

describe("public workload-headroom reader memo", () => {
	it("serves a cached answer inside the TTL without rescanning", async () => {
		let scans = 0;
		let clock = NOW;
		const read = createPublicWorkloadHeadroomReaderFromScan(
			async () => {
				scans++;
				return snapshot(clock);
			},
			{ now: () => clock, ttlMs: 60_000 },
		);

		const first = await read();
		clock += 59_000;
		const second = await read();

		expect(scans).toBe(1);
		// The same measurement, reporting the instant it was COMPUTED rather than
		// the instant it was asked for.
		expect(second.generatedAtMs).toBe(first.generatedAtMs);
	});

	it("rescans once the TTL has passed", async () => {
		let scans = 0;
		let clock = NOW;
		const read = createPublicWorkloadHeadroomReaderFromScan(
			async () => {
				scans++;
				return snapshot(clock);
			},
			{ now: () => clock, ttlMs: 60_000 },
		);

		await read();
		clock += 60_001;
		const second = await read();

		expect(scans).toBe(2);
		expect(second.generatedAtMs).toBe(NOW + 60_001);
	});

	it("collapses concurrent polls into a single scan", async () => {
		let scans = 0;
		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = createPublicWorkloadHeadroomReaderFromScan(
			async () => {
				scans++;
				await gate;
				return snapshot(NOW);
			},
			{ now: () => NOW, ttlMs: 60_000 },
		);

		const polls = Promise.all([read(), read(), read()]);
		release?.();
		await polls;

		// A burst costs one scan, not one each — which is the whole point of
		// checking `inFlight` before starting a read rather than after.
		expect(scans).toBe(1);
	});

	it("does not pin a failed read for every later caller", async () => {
		let scans = 0;
		const read = createPublicWorkloadHeadroomReaderFromScan(
			async () => {
				scans++;
				if (scans === 1) throw new Error("scan failed");
				return snapshot(NOW);
			},
			{ now: () => NOW, ttlMs: 60_000 },
		);

		await expect(read()).rejects.toThrow("scan failed");
		// `inFlight` is cleared in a `finally`, so the rejected promise is not left
		// behind to be handed to everyone who asks next.
		await expect(read()).resolves.toEqual(snapshot(NOW));
		expect(scans).toBe(2);
	});
});
