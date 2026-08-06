import { afterEach, describe, expect, it } from "bun:test";
import {
	__bootProvenanceTestHooks,
	type BootProvenance,
	captureBootProvenance,
	getBootProvenance,
	isRestartPending,
} from "../boot-provenance";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function reader(sha: string | null) {
	return () =>
		sha === null ? null : { sha, date: "2026-08-06T10:00:00+02:00" };
}

afterEach(() => {
	__bootProvenanceTestHooks.reset();
});

describe("captureBootProvenance", () => {
	it("records the commit the process booted on", () => {
		const boot = captureBootProvenance({
			readCommit: reader(SHA),
			now: () => 1_700_000_000_000,
		});

		expect(boot).toEqual({
			sha: SHA,
			shortSha: "aaaaaaa",
			date: "2026-08-06T10:00:00+02:00",
			bootedAt: 1_700_000_000_000,
		});
		expect(getBootProvenance()).toEqual(boot as BootProvenance);
	});

	it("is idempotent — a second call neither re-reads git nor moves bootedAt", () => {
		// The live checkout IS the deployment, so HEAD can move under a running
		// process. Re-capturing would erase the very signal this exists to give.
		const first = captureBootProvenance({
			readCommit: reader(SHA),
			now: () => 1_700_000_000_000,
		});

		let reReads = 0;
		const second = captureBootProvenance({
			readCommit: () => {
				reReads++;
				return { sha: OTHER_SHA, date: "2026-08-06T12:00:00+02:00" };
			},
			now: () => 1_700_000_999_000,
		});

		expect(reReads).toBe(0);
		expect(second).toEqual(first as BootProvenance);
		expect(getBootProvenance()?.bootedAt).toBe(1_700_000_000_000);
	});

	it("yields null when the commit can't be read (no git), and does not retry", () => {
		// Absence of signal, never an invented one.
		let reads = 0;
		const failing = () => {
			reads++;
			return null;
		};

		expect(captureBootProvenance({ readCommit: failing })).toBeNull();
		expect(captureBootProvenance({ readCommit: failing })).toBeNull();
		expect(reads).toBe(1);
		expect(getBootProvenance()).toBeNull();
	});
});

describe("getBootProvenance", () => {
	it("is null before capture — it never captures on demand", () => {
		// Capturing at first read would stamp request time, not boot time.
		expect(getBootProvenance()).toBeNull();
	});
});

describe("isRestartPending", () => {
	const boot: BootProvenance = {
		sha: SHA,
		shortSha: "aaaaaaa",
		date: "2026-08-06T10:00:00+02:00",
		bootedAt: 1_700_000_000_000,
	};

	it("is true when the checkout's HEAD moved away from the booted commit", () => {
		expect(isRestartPending(boot, OTHER_SHA)).toBe(true);
	});

	it("is false when the checkout is still on the booted commit", () => {
		expect(isRestartPending(boot, SHA)).toBe(false);
	});

	it("is false when boot provenance was never captured", () => {
		expect(isRestartPending(null, OTHER_SHA)).toBe(false);
	});

	it("is false when the current commit can't be determined", () => {
		expect(isRestartPending(boot, null)).toBe(false);
	});
});
