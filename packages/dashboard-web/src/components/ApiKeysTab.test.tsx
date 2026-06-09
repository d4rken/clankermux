import { describe, expect, it } from "bun:test";
import { describePinTarget } from "./ApiKeysTab";

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
