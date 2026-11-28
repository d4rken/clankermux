import { describe, expect, it } from "bun:test";
import {
	createRefusalFallbackRegistry,
	FALLBACK_CREDIT_TTL_MS,
	hashCreditToken,
} from "../refusal-fallback-registry";

const NO_ISSUER = { accountId: null, identityExternalId: null };

describe("hashCreditToken", () => {
	it("is deterministic, 32 hex chars, and never echoes the token", () => {
		const token = "fbc_01HXQ_secret_token_value";
		const hash = hashCreditToken(token);
		expect(hash).toMatch(/^[0-9a-f]{32}$/);
		expect(hash).toBe(hashCreditToken(token));
		expect(hash).not.toContain("secret");
	});

	it("separates different tokens", () => {
		expect(hashCreditToken("a")).not.toBe(hashCreditToken("b"));
	});
});

describe("createRefusalFallbackRegistry", () => {
	it("returns the noted origin exactly once", () => {
		const registry = createRefusalFallbackRegistry();
		const hash = hashCreditToken("token-1");
		registry.noteRefusal(hash, {
			model: "claude-fable-5-1",
			category: "cyber",
			at: 1_000,
			accountId: "acc-issuer",
			identityExternalId: "org-issuer",
		});

		expect(registry.takeOrigin(hash, 2_000)).toEqual({
			model: "claude-fable-5-1",
			category: "cyber",
			at: 1_000,
			accountId: "acc-issuer",
			identityExternalId: "org-issuer",
		});
		// A credit is redeemed once — a replay of the same token resolves nothing.
		expect(registry.takeOrigin(hash, 2_001)).toBeNull();
		expect(registry.size()).toBe(0);
	});

	it("gives a credit one hour to be redeemed", () => {
		expect(FALLBACK_CREDIT_TTL_MS).toBe(60 * 60_000);
	});

	it("drops an entry past the credit lifetime", () => {
		const registry = createRefusalFallbackRegistry();
		const hash = hashCreditToken("token-expired");
		registry.noteRefusal(hash, {
			model: "m",
			category: "unknown",
			at: 0,
			...NO_ISSUER,
		});

		expect(registry.takeOrigin(hash, FALLBACK_CREDIT_TTL_MS + 1)).toBeNull();
		expect(registry.size()).toBe(0);
	});

	it("keeps an entry that is exactly at the lifetime boundary", () => {
		const registry = createRefusalFallbackRegistry();
		const hash = hashCreditToken("token-boundary");
		registry.noteRefusal(hash, {
			model: "m",
			category: "unknown",
			at: 0,
			...NO_ISSUER,
		});

		expect(registry.takeOrigin(hash, FALLBACK_CREDIT_TTL_MS)?.model).toBe("m");
	});

	it("returns an entry just inside the credit lifetime with its issuer", () => {
		const registry = createRefusalFallbackRegistry();
		const hash = hashCreditToken("token-inside");
		registry.noteRefusal(hash, {
			model: "m",
			category: "unknown",
			at: 0,
			accountId: "acc-issuer",
			identityExternalId: "org-issuer",
		});

		const origin = registry.takeOrigin(hash, FALLBACK_CREDIT_TTL_MS - 1);
		expect(origin?.accountId).toBe("acc-issuer");
		expect(origin?.identityExternalId).toBe("org-issuer");
	});

	it("resolves concurrent refusals independently, in any retry order", () => {
		const registry = createRefusalFallbackRegistry();
		const first = hashCreditToken("token-a");
		const second = hashCreditToken("token-b");
		registry.noteRefusal(first, {
			model: "claude-fable-5-1",
			category: "cyber",
			at: 1_000,
			...NO_ISSUER,
		});
		registry.noteRefusal(second, {
			model: "gpt-5.5",
			category: "content_filter",
			at: 1_100,
			...NO_ISSUER,
		});

		// Retried out of order: the second refusal's credit is redeemed first.
		expect(registry.takeOrigin(second, 1_200)?.model).toBe("gpt-5.5");
		expect(registry.takeOrigin(first, 1_300)?.model).toBe("claude-fable-5-1");
	});

	it("sweeps stale entries on any call, not just on the matching take", () => {
		const registry = createRefusalFallbackRegistry();
		registry.noteRefusal(hashCreditToken("old"), {
			model: "m",
			category: "unknown",
			at: 0,
			...NO_ISSUER,
		});
		expect(registry.size()).toBe(1);

		registry.noteRefusal(hashCreditToken("fresh"), {
			model: "m2",
			category: "unknown",
			at: FALLBACK_CREDIT_TTL_MS + 5,
			...NO_ISSUER,
		});
		expect(registry.size()).toBe(1);
		expect(
			registry.takeOrigin(hashCreditToken("fresh"), FALLBACK_CREDIT_TTL_MS + 6)
				?.model,
		).toBe("m2");
	});

	it("reset() empties the registry", () => {
		const registry = createRefusalFallbackRegistry();
		registry.noteRefusal(hashCreditToken("x"), {
			model: "m",
			category: "unknown",
			at: 1,
			...NO_ISSUER,
		});
		registry.reset();
		expect(registry.size()).toBe(0);
		expect(registry.takeOrigin(hashCreditToken("x"), 2)).toBeNull();
	});
});
