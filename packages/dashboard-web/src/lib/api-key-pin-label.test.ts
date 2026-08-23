import { describe, expect, it } from "bun:test";
import { describePinTarget } from "./api-key-pin-label";

const accounts = [
	{ id: "acc-1", name: "Primary" },
	{ id: "acc-2", name: "Backup" },
];

describe("describePinTarget", () => {
	it("reports an account pin by name", () => {
		expect(
			describePinTarget({ accountId: "acc-2", providers: null }, accounts),
		).toBe("Pinned → Backup");
	});

	it("falls back to the id when the pinned account is gone", () => {
		expect(
			describePinTarget(
				{ accountId: "acc-removed", providers: null },
				accounts,
			),
		).toBe("Pinned → acc-removed");
	});

	it("reports a provider-class pin with providers joined", () => {
		expect(
			describePinTarget(
				{ accountId: null, providers: ["anthropic", "openai"] },
				accounts,
			),
		).toBe("Pinned → anthropic, openai");
	});

	it("prefers the account pin when both are present", () => {
		expect(
			describePinTarget(
				{ accountId: "acc-1", providers: ["openai"] },
				accounts,
			),
		).toBe("Pinned → Primary");
	});

	it("reports Unpinned when nothing is pinned", () => {
		expect(
			describePinTarget({ accountId: null, providers: null }, accounts),
		).toBe("Unpinned");
	});

	it("treats an empty providers array as Unpinned", () => {
		expect(
			describePinTarget({ accountId: null, providers: [] }, accounts),
		).toBe("Unpinned");
	});
});
