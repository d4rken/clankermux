import { describe, expect, it } from "bun:test";
import { isGenuineWindowRoll, toEpochMs } from "../window-reset";

describe("toEpochMs", () => {
	it("parses a valid ISO string to epoch ms", () => {
		const iso = "2030-01-01T12:00:00Z";
		expect(toEpochMs(iso)).toBe(new Date(iso).getTime());
	});

	it("passes a numeric value through unchanged", () => {
		expect(toEpochMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	});

	it("returns null for null", () => {
		expect(toEpochMs(null)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(toEpochMs(undefined)).toBeNull();
	});

	it("returns null for an unparseable string", () => {
		expect(toEpochMs("not-a-date")).toBeNull();
	});
});

describe("isGenuineWindowRoll", () => {
	const now = 1_000_000_000_000;

	it("returns false for sub-second drift of a still-future reset", () => {
		const futureReset = now + 4 * 60 * 60 * 1000; // 4h ahead
		// prev > now (still future) → not a roll even though new is later
		expect(isGenuineWindowRoll(futureReset, futureReset + 215, now)).toBe(
			false,
		);
	});

	it("returns true for a genuine roll (prev already arrived, new later)", () => {
		const passedReset = now - 1_000; // previous window's reset just arrived
		const nextReset = now + 5 * 60 * 60 * 1000;
		expect(isGenuineWindowRoll(passedReset, nextReset, now)).toBe(true);
	});

	it("returns false for equal timestamps", () => {
		const passedReset = now - 1_000;
		expect(isGenuineWindowRoll(passedReset, passedReset, now)).toBe(false);
	});

	it("returns false when prevResetAt is null", () => {
		expect(isGenuineWindowRoll(null, now + 1000, now)).toBe(false);
	});

	it("returns false when newResetAt is null", () => {
		expect(isGenuineWindowRoll(now - 1000, null, now)).toBe(false);
	});

	it("returns false when the new reset is earlier than the previous", () => {
		const passedReset = now - 1_000;
		expect(isGenuineWindowRoll(passedReset, passedReset - 5_000, now)).toBe(
			false,
		);
	});
});
