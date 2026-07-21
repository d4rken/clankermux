import { describe, expect, test } from "bun:test";
import {
	getLastProtectedFamilyDemand,
	recordProtectedFamilyDemand,
} from "./protected-family-demand";

// The backing map is a module-level global, so each test uses a distinct
// accountId to avoid cross-test leakage — do NOT rely on test ordering.
describe("protected-family-demand", () => {
	test("record then get returns the recorded timestamp", () => {
		const now = 1_700_000_000_000;
		recordProtectedFamilyDemand("acct-record-get", now);
		expect(getLastProtectedFamilyDemand("acct-record-get")).toBe(now);
	});

	test("get for an unknown account returns null", () => {
		expect(getLastProtectedFamilyDemand("acct-unknown")).toBeNull();
	});

	test("recording again overwrites with the newer timestamp", () => {
		const first = 1_700_000_000_000;
		const second = first + 5_000;
		recordProtectedFamilyDemand("acct-overwrite", first);
		recordProtectedFamilyDemand("acct-overwrite", second);
		expect(getLastProtectedFamilyDemand("acct-overwrite")).toBe(second);
	});
});
