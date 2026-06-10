import { describe, expect, it } from "bun:test";
import {
	type ApiKeySortMode,
	describePinTarget,
	parseApiKeySortMode,
	sortApiKeys,
	validateRenameKey,
} from "./ApiKeysTab";

const accounts = [
	{ id: "acc-1", name: "Primary" },
	{ id: "acc-2", name: "Backup" },
];

describe("describePinTarget", () => {
	it("reports an account pin by name", () => {
		expect(
			describePinTarget(
				{ pinnedAccountId: "acc-2", pinnedProviders: null },
				accounts,
			),
		).toBe("Pinned → Backup");
	});

	it("falls back to the id when the pinned account is gone", () => {
		expect(
			describePinTarget(
				{ pinnedAccountId: "acc-removed", pinnedProviders: null },
				accounts,
			),
		).toBe("Pinned → acc-removed");
	});

	it("reports a provider-class pin with providers joined", () => {
		expect(
			describePinTarget(
				{ pinnedAccountId: null, pinnedProviders: ["anthropic", "openai"] },
				accounts,
			),
		).toBe("Pinned → anthropic, openai");
	});

	it("prefers the account pin when both are present", () => {
		expect(
			describePinTarget(
				{ pinnedAccountId: "acc-1", pinnedProviders: ["openai"] },
				accounts,
			),
		).toBe("Pinned → Primary");
	});

	it("reports Unpinned when nothing is pinned", () => {
		expect(
			describePinTarget(
				{ pinnedAccountId: null, pinnedProviders: null },
				accounts,
			),
		).toBe("Unpinned");
	});

	it("treats an empty providers array as Unpinned", () => {
		expect(
			describePinTarget(
				{ pinnedAccountId: null, pinnedProviders: [] },
				accounts,
			),
		).toBe("Unpinned");
	});
});

// validateRenameKey is the pure gate behind the rename dialog: it backs both the
// inline error message and the Save-button disabled state. A `null` return means
// the trimmed name is valid AND changed, so Save is enabled and the request may
// fire; any string is the error to show and the reason Save stays disabled.
describe("validateRenameKey", () => {
	it("returns null for a valid, changed name (Save enabled)", () => {
		expect(validateRenameKey("New Name", "Old Name")).toBeNull();
	});

	it("trims surrounding whitespace before comparing", () => {
		// trims to "New Name" which differs from current → still submittable
		expect(validateRenameKey("  New Name  ", "Old Name")).toBeNull();
	});

	it("blocks an empty name (Save disabled)", () => {
		expect(validateRenameKey("", "Old Name")).toBe("Name cannot be empty");
	});

	it("blocks a whitespace-only name (Save disabled)", () => {
		expect(validateRenameKey("   ", "Old Name")).toBe("Name cannot be empty");
	});

	it("blocks a name unchanged from the current one (Save disabled)", () => {
		expect(validateRenameKey("Old Name", "Old Name")).toBe("Name is unchanged");
	});

	it("treats a name that only differs by surrounding whitespace as unchanged", () => {
		expect(validateRenameKey("  Old Name  ", "Old Name")).toBe(
			"Name is unchanged",
		);
	});

	it("blocks a name longer than 100 characters (Save disabled)", () => {
		expect(validateRenameKey("a".repeat(101), "Old Name")).toBe(
			"Name cannot exceed 100 characters",
		);
	});

	it("allows a name of exactly 100 characters", () => {
		expect(validateRenameKey("a".repeat(100), "Old Name")).toBeNull();
	});
});

// Minimal key rows for sort tests — only the fields sortApiKeys reads, plus an
// id so assertions can name rows unambiguously.
function makeKey(
	id: string,
	overrides: Partial<{
		name: string;
		createdAt: string;
		lastUsed: string | null;
		usageCount: number;
	}> = {},
) {
	return {
		id,
		name: overrides.name ?? id,
		createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
		lastUsed: overrides.lastUsed === undefined ? null : overrides.lastUsed,
		usageCount: overrides.usageCount ?? 0,
	};
}

const ids = (keys: { id: string }[]) => keys.map((k) => k.id);

describe("sortApiKeys", () => {
	it("sorts by created, newest first (matches the server's default order)", () => {
		const keys = [
			makeKey("old", { createdAt: "2026-01-01T00:00:00.000Z" }),
			makeKey("new", { createdAt: "2026-03-01T00:00:00.000Z" }),
			makeKey("mid", { createdAt: "2026-02-01T00:00:00.000Z" }),
		];
		expect(ids(sortApiKeys(keys, "created"))).toEqual(["new", "mid", "old"]);
	});

	it("sorts by name alphabetically, case-insensitively", () => {
		const keys = [
			makeKey("b", { name: "bravo" }),
			makeKey("A", { name: "Alpha" }),
			makeKey("c", { name: "Charlie" }),
		];
		expect(ids(sortApiKeys(keys, "name"))).toEqual(["A", "b", "c"]);
	});

	it("sorts by request count, highest first", () => {
		const keys = [
			makeKey("low", { usageCount: 3 }),
			makeKey("high", { usageCount: 500 }),
			makeKey("none", { usageCount: 0 }),
		];
		expect(ids(sortApiKeys(keys, "requests"))).toEqual(["high", "low", "none"]);
	});

	it("sorts by last used, most recent first, never-used keys last", () => {
		const keys = [
			makeKey("never", { lastUsed: null }),
			makeKey("recent", { lastUsed: "2026-06-01T00:00:00.000Z" }),
			makeKey("stale", { lastUsed: "2026-01-01T00:00:00.000Z" }),
		];
		expect(ids(sortApiKeys(keys, "lastUsed"))).toEqual([
			"recent",
			"stale",
			"never",
		]);
	});

	it("breaks ties by name so equal rows have a deterministic order", () => {
		const keys = [
			makeKey("z", { name: "zulu", usageCount: 7 }),
			makeKey("a", { name: "alpha", usageCount: 7 }),
		];
		expect(ids(sortApiKeys(keys, "requests"))).toEqual(["a", "z"]);
		expect(
			ids(
				sortApiKeys(
					[
						makeKey("z", { name: "zulu", lastUsed: null }),
						makeKey("a", { name: "alpha", lastUsed: null }),
					],
					"lastUsed",
				),
			),
		).toEqual(["a", "z"]);
	});

	it("does not mutate the input array", () => {
		const keys = [
			makeKey("b", { name: "bravo" }),
			makeKey("a", { name: "alpha" }),
		];
		sortApiKeys(keys, "name");
		expect(ids(keys)).toEqual(["b", "a"]);
	});
});

describe("parseApiKeySortMode", () => {
	it.each<ApiKeySortMode>([
		"created",
		"name",
		"requests",
		"lastUsed",
	])("round-trips the valid mode %p", (mode) => {
		expect(parseApiKeySortMode(mode)).toBe(mode);
	});

	it("falls back to created for unknown or missing values", () => {
		expect(parseApiKeySortMode("garbage")).toBe("created");
		expect(parseApiKeySortMode(null)).toBe("created");
	});
});
