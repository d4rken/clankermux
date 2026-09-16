import { describe, expect, it } from "bun:test";
import {
	ACCOUNT_LIST_SORT_LABELS,
	ACCOUNT_LIST_SORT_MODES,
	parseAccountListSortMode,
	renewalSortKey,
	type SortableListAccount,
	sortAccountList,
} from "./account-list-sort";

/** 2026-06-15T12:00:00 local, the clock every renewal case below reads. */
const NOW = new Date(2026, 5, 15, 12).getTime();

function account(
	name: string,
	overrides: Partial<SortableListAccount> = {},
): SortableListAccount {
	return {
		id: `id-${name}`,
		name,
		provider: "anthropic",
		refreshTokenExpiresAt: null,
		renewalAnchor: null,
		renewalCadence: null,
		...overrides,
	};
}

const names = (accounts: readonly SortableListAccount[]) =>
	accounts.map((a) => a.name);

describe("parseAccountListSortMode", () => {
	it("accepts every mode the dropdown lists", () => {
		for (const mode of ACCOUNT_LIST_SORT_MODES) {
			expect(parseAccountListSortMode(mode)).toBe(mode);
		}
	});

	it("falls back to the server order for unknown or missing values", () => {
		expect(parseAccountListSortMode(null)).toBe("default");
		expect(parseAccountListSortMode("")).toBe("default");
		expect(parseAccountListSortMode("utilization-desc")).toBe("default");
	});

	it("labels every mode", () => {
		for (const mode of ACCOUNT_LIST_SORT_MODES) {
			expect(ACCOUNT_LIST_SORT_LABELS[mode]).toBeTruthy();
		}
	});
});

describe("sortAccountList", () => {
	it("leaves the server order alone in default mode", () => {
		const input = [account("zulu"), account("alpha"), account("mike")];
		expect(names(sortAccountList(input, "default", NOW))).toEqual([
			"zulu",
			"alpha",
			"mike",
		]);
	});

	it("never mutates the input array", () => {
		const input = [account("zulu"), account("alpha")];
		sortAccountList(input, "name", NOW);
		expect(names(input)).toEqual(["zulu", "alpha"]);
	});

	it("orders by name case-insensitively", () => {
		const input = [account("zulu"), account("Alpha"), account("mike")];
		expect(names(sortAccountList(input, "name", NOW))).toEqual([
			"Alpha",
			"mike",
			"zulu",
		]);
	});

	it("groups by provider display name, then by account name", () => {
		const input = [
			account("z-anthropic", { provider: "anthropic" }),
			account("b-zai", { provider: "zai" }),
			account("a-codex", { provider: "codex" }),
			account("a-anthropic", { provider: "anthropic" }),
		];
		expect(names(sortAccountList(input, "provider", NOW))).toEqual([
			"a-anthropic",
			"z-anthropic",
			"a-codex",
			"b-zai",
		]);
	});

	it("puts the soonest re-auth deadline first and no-deadline accounts last", () => {
		const input = [
			account("no-deadline", { provider: "codex" }),
			account("later", { refreshTokenExpiresAt: "2026-10-12T00:00:00.000Z" }),
			account("sooner", { refreshTokenExpiresAt: "2026-10-07T00:00:00.000Z" }),
		];
		expect(names(sortAccountList(input, "reauth", NOW))).toEqual([
			"sooner",
			"later",
			"no-deadline",
		]);
	});

	it("keeps no-deadline accounts in name order rather than input order", () => {
		const input = [
			account("zulu", { provider: "codex" }),
			account("alpha", { provider: "zai" }),
		];
		expect(names(sortAccountList(input, "reauth", NOW))).toEqual([
			"alpha",
			"zulu",
		]);
	});

	it("treats an unparsable deadline as no deadline", () => {
		const input = [
			account("broken", { refreshTokenExpiresAt: "not-a-date" }),
			account("real", { refreshTokenExpiresAt: "2026-10-07T00:00:00.000Z" }),
		];
		expect(names(sortAccountList(input, "reauth", NOW))).toEqual([
			"real",
			"broken",
		]);
	});

	it("orders renewals by the NEXT occurrence, not the stored anchor", () => {
		// `old-anchor` has the earlier anchor but renews on the 20th of every
		// month, so from Jun 15 it comes after the account anchored on the 18th.
		const input = [
			account("old-anchor", {
				renewalAnchor: "2024-01-20",
				renewalCadence: "monthly",
			}),
			account("recent-anchor", {
				renewalAnchor: "2026-05-18",
				renewalCadence: "monthly",
			}),
			account("unset"),
		];
		expect(names(sortAccountList(input, "renewal", NOW))).toEqual([
			"recent-anchor",
			"old-anchor",
			"unset",
		]);
	});

	it("keeps a one-off (cadence none) renewal that has passed ahead of unset accounts", () => {
		const input = [
			account("unset"),
			account("past-oneoff", {
				renewalAnchor: "2026-01-09",
				renewalCadence: "none",
			}),
		];
		expect(names(sortAccountList(input, "renewal", NOW))).toEqual([
			"past-oneoff",
			"unset",
		]);
	});
});

describe("renewalSortKey", () => {
	it("returns Infinity when no anchor is set", () => {
		expect(renewalSortKey(account("a"), NOW)).toBe(Number.POSITIVE_INFINITY);
	});

	it("reads a one-off anchor as its literal date", () => {
		expect(
			renewalSortKey(
				account("a", { renewalAnchor: "2026-05-18", renewalCadence: "none" }),
				NOW,
			),
		).toBe(new Date(2026, 4, 18).getTime());
	});

	it("resolves a monthly anchor to the next occurrence on or after today", () => {
		expect(
			renewalSortKey(
				account("a", {
					renewalAnchor: "2024-01-20",
					renewalCadence: "monthly",
				}),
				NOW,
			),
		).toBe(new Date(2026, 5, 20).getTime());
	});
});
