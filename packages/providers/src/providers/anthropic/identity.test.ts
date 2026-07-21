import { describe, expect, it } from "bun:test";
import { extractAnthropicIdentity } from "./identity";

describe("extractAnthropicIdentity", () => {
	it("extracts a full identity and normalizes the plan tier + rate-limit tier", () => {
		expect(
			extractAnthropicIdentity({
				account: {
					uuid: "acct-uuid-1",
					email_address: "Owner@Example.com",
				},
				organization: {
					name: "Acme Inc",
					organization_type: "claude_max",
					rate_limit_tier: "default_claude_max_20x",
				},
			}),
		).toEqual({
			externalAccountId: "acct-uuid-1",
			email: "owner@example.com",
			organizationName: "Acme Inc",
			planTier: "max",
			rateLimitTier: "20x",
		});
	});

	it("normalizes rate_limit_tier multiplier suffixes to a short token", () => {
		const cases: Array<[string, string]> = [
			["default_claude_max_20x", "20x"],
			["default_claude_max_5x", "5x"],
			["default_claude_max_1x", "1x"],
			["DEFAULT_CLAUDE_MAX_20X", "20x"], // case-insensitive suffix
		];
		for (const [raw, expected] of cases) {
			const identity = extractAnthropicIdentity({
				organization: { rate_limit_tier: raw },
			});
			expect(identity?.rateLimitTier).toBe(expected);
		}
	});

	it("keeps a rate_limit_tier with no multiplier suffix, stripping the default_ prefix", () => {
		const identity = extractAnthropicIdentity({
			organization: { rate_limit_tier: "default_claude_pro" },
		});
		expect(identity?.rateLimitTier).toBe("pro");
	});

	it("returns rateLimitTier null when rate_limit_tier is absent", () => {
		const identity = extractAnthropicIdentity({
			organization: { name: "Org", organization_type: "claude_max" },
		});
		expect(identity?.rateLimitTier).toBeNull();
	});

	it("falls back to `email` when `email_address` is absent", () => {
		const identity = extractAnthropicIdentity({
			account: { uuid: "u2", email: "Fallback@Example.com" },
		});
		expect(identity?.email).toBe("fallback@example.com");
		expect(identity?.externalAccountId).toBe("u2");
	});

	it("falls back to organization.type and passes unknown tiers through lowercased", () => {
		const identity = extractAnthropicIdentity({
			organization: { name: "Org", type: "Claude_Something_New" },
		});
		expect(identity?.planTier).toBe("claude_something_new");
		expect(identity?.organizationName).toBe("Org");
	});

	it("maps each known tier", () => {
		const cases: Array<[string, string]> = [
			["claude_max", "max"],
			["claude_pro", "pro"],
			["claude_team", "team"],
			["claude_enterprise", "enterprise"],
		];
		for (const [raw, expected] of cases) {
			const identity = extractAnthropicIdentity({
				organization: { organization_type: raw },
			});
			expect(identity?.planTier).toBe(expected);
		}
	});

	it("returns null when both account and organization are absent", () => {
		expect(extractAnthropicIdentity({})).toBeNull();
		expect(extractAnthropicIdentity(null)).toBeNull();
		expect(extractAnthropicIdentity("nope")).toBeNull();
		expect(
			extractAnthropicIdentity({ account: "bad", organization: 3 }),
		).toBeNull();
	});

	it("yields null fields for present-but-empty account/organization objects", () => {
		expect(extractAnthropicIdentity({ account: {} })).toEqual({
			externalAccountId: null,
			email: null,
			organizationName: null,
			planTier: null,
			rateLimitTier: null,
		});
	});
});
