import { describe, expect, it } from "bun:test";
import {
	isAccountAllowedByPin,
	isPinActive,
	isRoutingPinValid,
} from "./api-key-pin";

const anthropicAccount = { id: "acc-1", provider: "anthropic" };
const codexAccount = { id: "acc-2", provider: "codex" };

describe("isPinActive", () => {
	it("treats a missing pin as unpinned", () => {
		expect(isPinActive(null)).toBe(false);
		expect(isPinActive(undefined)).toBe(false);
	});

	it("treats a pin naming neither an account nor a class as unpinned", () => {
		expect(isPinActive({ accountId: null, providers: null })).toBe(false);
	});

	it("treats an empty provider list as unpinned", () => {
		expect(isPinActive({ accountId: null, providers: [] })).toBe(false);
	});

	it("is active for an account pin", () => {
		expect(isPinActive({ accountId: "acc-1", providers: null })).toBe(true);
	});

	it("is active for a non-empty class pin", () => {
		expect(isPinActive({ accountId: null, providers: ["codex"] })).toBe(true);
	});
});

describe("isAccountAllowedByPin", () => {
	it("allows every account when the pin is inactive", () => {
		for (const pin of [
			null,
			undefined,
			{ accountId: null, providers: null },
			{ accountId: null, providers: [] },
		]) {
			expect(isAccountAllowedByPin(pin, anthropicAccount)).toBe(true);
			expect(isAccountAllowedByPin(pin, codexAccount)).toBe(true);
		}
	});

	it("matches an account pin by id", () => {
		const pin = { accountId: "acc-1", providers: null };
		expect(isAccountAllowedByPin(pin, anthropicAccount)).toBe(true);
		expect(isAccountAllowedByPin(pin, codexAccount)).toBe(false);
	});

	it("matches a class pin by provider", () => {
		const pin = { accountId: null, providers: ["codex", "openai-compatible"] };
		expect(isAccountAllowedByPin(pin, codexAccount)).toBe(true);
		expect(isAccountAllowedByPin(pin, anthropicAccount)).toBe(false);
	});

	it("lets an account pin take precedence over a class pin", () => {
		const pin = { accountId: "acc-1", providers: ["codex"] };
		expect(isAccountAllowedByPin(pin, anthropicAccount)).toBe(true);
		expect(isAccountAllowedByPin(pin, codexAccount)).toBe(false);
	});
});

describe("provider exclusions", () => {
	const pin = {
		accountId: null,
		providers: null,
		excludedProviders: ["anthropic"],
	};
	it("excludes only the selected provider and admits new providers", () => {
		expect(isPinActive(pin)).toBe(true);
		expect(isAccountAllowedByPin(pin, anthropicAccount)).toBe(false);
		for (const provider of [
			"codex",
			"claude-console-api",
			"openrouter",
			"future-provider",
		])
			expect(isAccountAllowedByPin(pin, { id: provider, provider })).toBe(true);
	});
	it("does not let an account pin bypass an exclusion", () => {
		expect(
			isAccountAllowedByPin(
				{ ...pin, accountId: anthropicAccount.id },
				anthropicAccount,
			),
		).toBe(false);
	});
	it("validates exclusive destination modes and provider names", () => {
		expect(isRoutingPinValid(pin)).toBe(true);
		expect(isRoutingPinValid({ accountId: null, providers: null })).toBe(true);
		for (const invalid of [
			{ ...pin, accountId: "acc-1" },
			{ ...pin, providers: ["codex"] },
			{ ...pin, excludedProviders: [] },
			{ ...pin, excludedProviders: ["unknown-provider"] },
		]) {
			expect(isRoutingPinValid(invalid)).toBe(false);
			expect(isAccountAllowedByPin(invalid, codexAccount)).toBe(false);
		}
	});
});
