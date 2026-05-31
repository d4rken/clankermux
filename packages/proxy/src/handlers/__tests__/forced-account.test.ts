import { afterEach, describe, expect, it } from "bun:test";
import { getForcedAccount, setForcedAccount } from "../forced-account";

describe("forced-account singleton", () => {
	afterEach(() => {
		// Keep the module-level singleton deterministic across tests.
		setForcedAccount(null);
	});

	it("defaults to null", () => {
		expect(getForcedAccount()).toBeNull();
	});

	it("set then get returns the forced id", () => {
		setForcedAccount("acc-1");
		expect(getForcedAccount()).toBe("acc-1");
	});

	it("setting a new id replaces the old (one at a time)", () => {
		setForcedAccount("acc-1");
		expect(getForcedAccount()).toBe("acc-1");
		setForcedAccount("acc-2");
		expect(getForcedAccount()).toBe("acc-2");
	});

	it("set(null) clears the force", () => {
		setForcedAccount("acc-1");
		expect(getForcedAccount()).toBe("acc-1");
		setForcedAccount(null);
		expect(getForcedAccount()).toBeNull();
	});
});
