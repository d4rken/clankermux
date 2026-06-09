import { describe, expect, it } from "bun:test";
import { describePinTarget, validateRenameKey } from "./ApiKeysTab";

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
