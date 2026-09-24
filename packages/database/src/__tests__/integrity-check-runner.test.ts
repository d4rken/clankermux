import { describe, expect, it } from "bun:test";
import { integrityWorkerTimeoutMs } from "../integrity-check-runner";

const GiB = 1024 ** 3;
const TEN_MIN = 10 * 60 * 1000;

describe("integrityWorkerTimeoutMs", () => {
	it("keeps quick checks at the fixed 10-minute cap regardless of size", () => {
		expect(integrityWorkerTimeoutMs("quick", 40 * GiB)).toBe(TEN_MIN);
		expect(integrityWorkerTimeoutMs("quick", null)).toBe(TEN_MIN);
	});

	it("never gives a full check less than the 10-minute floor", () => {
		expect(integrityWorkerTimeoutMs("full", 0)).toBe(TEN_MIN);
		expect(integrityWorkerTimeoutMs("full", 5 * GiB)).toBe(TEN_MIN);
		expect(integrityWorkerTimeoutMs("full", null)).toBe(TEN_MIN);
	});

	it("scales a full check at 60 s per GiB above the floor", () => {
		// 17 GiB measured 8m44s idle and overran 10 min under load.
		expect(integrityWorkerTimeoutMs("full", 17 * GiB)).toBe(17 * 60_000);
		expect(integrityWorkerTimeoutMs("full", 64 * GiB)).toBe(64 * 60_000);
		expect(integrityWorkerTimeoutMs("full", 10.5 * GiB)).toBe(630_000);
	});
});
