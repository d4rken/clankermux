import { describe, expect, it } from "bun:test";
import type { KeyRunway } from "@clankermux/core";
import type { RunwayAccountSummary } from "@clankermux/types";
import {
	msUntilNextReset,
	reachableAccounts,
	tightestWindow,
} from "./runway-evidence";

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function account(
	id: string,
	windows: Array<{
		kind: "five_hour" | "seven_day";
		utilizationPct: number | null;
		resetsAtMs: number | null;
	}>,
): RunwayAccountSummary {
	return {
		id,
		name: id,
		provider: "anthropic",
		metered: true,
		usageAsOfMs: NOW,
		windows: windows.map((w) => ({ ...w, prediction: null })),
	};
}

function key(id: string, eligible: string[], isActive = true): KeyRunway {
	return {
		keyId: id,
		keyName: id,
		isActive,
		pin: { accountId: null, providers: null },
		eligibleAccountIds: eligible,
		outcome: { kind: "unknown" },
	};
}

describe("reachableAccounts", () => {
	it("unions the eligible sets of active keys", () => {
		const accounts = [account("a", []), account("b", []), account("c", [])];
		const keys = [key("k1", ["a"]), key("k2", ["b"])];

		expect(reachableAccounts(keys, accounts).map((a) => a.id)).toEqual([
			"a",
			"b",
		]);
	});

	it("excludes accounts only an inactive key can reach", () => {
		const accounts = [account("a", []), account("b", [])];
		const keys = [key("k1", ["a"]), key("k2", ["b"], false)];

		// A disabled key describes a route nothing can take, so the accounts
		// behind it are not part of the pool this dashboard is about.
		expect(reachableAccounts(keys, accounts).map((a) => a.id)).toEqual(["a"]);
	});
});

describe("tightestWindow", () => {
	it("picks the single highest window, not the account average", () => {
		const accounts = [
			account("low", [
				{ kind: "five_hour", utilizationPct: 30, resetsAtMs: null },
				{ kind: "seven_day", utilizationPct: 30, resetsAtMs: null },
			]),
			account("spiky", [
				{ kind: "five_hour", utilizationPct: 5, resetsAtMs: null },
				{ kind: "seven_day", utilizationPct: 97, resetsAtMs: null },
			]),
		];

		const tightest = tightestWindow(accounts, NOW);

		// The binding constraint, deliberately NOT the pool average the 5h/7d
		// tiles beside it report: a pool at 40% with one account at 97% is one
		// account away from losing a route.
		expect(tightest?.accountId).toBe("spiky");
		expect(tightest?.kind).toBe("seven_day");
		expect(tightest?.label).toBe("weekly · 97%");
	});

	it("returns null when no window carries a utilization", () => {
		const accounts = [
			account("cold", [
				{ kind: "five_hour", utilizationPct: null, resetsAtMs: NOW + HOUR },
			]),
		];

		// Never 0: a 0% window is a real, meaningful reading and must not double
		// as "we could not tell".
		expect(tightestWindow(accounts, NOW)).toBeNull();
	});

	it("reports a genuine zero rather than treating it as absent", () => {
		const accounts = [
			account("idle", [
				{ kind: "five_hour", utilizationPct: 0, resetsAtMs: NOW + HOUR },
			]),
		];

		expect(tightestWindow(accounts, NOW)?.utilizationPct).toBe(0);
	});
});

describe("msUntilNextReset", () => {
	it("returns the soonest reset still ahead", () => {
		const accounts = [
			account("a", [
				{ kind: "five_hour", utilizationPct: 10, resetsAtMs: NOW + 3 * HOUR },
				{ kind: "seven_day", utilizationPct: 10, resetsAtMs: NOW + 5 * DAY },
			]),
			account("b", [
				{ kind: "five_hour", utilizationPct: 10, resetsAtMs: NOW + HOUR },
			]),
		];

		expect(msUntilNextReset(accounts, NOW)).toBe(HOUR);
	});

	it("skips a reset that has already passed", () => {
		const accounts = [
			account("stale", [
				{ kind: "five_hour", utilizationPct: 10, resetsAtMs: NOW - HOUR },
				{ kind: "seven_day", utilizationPct: 10, resetsAtMs: NOW + 2 * DAY },
			]),
		];

		// A reset instant in the past means the reading predates the rollover, so
		// it says nothing about the NEXT reset. Clamping it to zero would report
		// relief that is not coming.
		expect(msUntilNextReset(accounts, NOW)).toBe(2 * DAY);
	});

	it("returns null when nothing reports a future reset", () => {
		const accounts = [
			account("none", [
				{ kind: "five_hour", utilizationPct: 10, resetsAtMs: null },
			]),
		];

		expect(msUntilNextReset(accounts, NOW)).toBeNull();
	});
});
