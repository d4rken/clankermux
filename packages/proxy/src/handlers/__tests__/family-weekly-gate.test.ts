import { describe, expect, it } from "bun:test";
import type {
	Account,
	AnthropicLimitEntry,
	AnthropicUsageData,
	CapacitySignal,
} from "@clankermux/types";
import {
	createFamilyWeeklyExhaustedResponse,
	type FamilyWeeklyExcludedAccount,
	resolveFamilyWeeklyExclusion,
	resolveTransientlyCooledFamilySibling,
} from "../family-weekly-gate";

const NOW = 1_000_000_000_000;
const FUTURE_ISO = new Date(NOW + 60 * 60 * 1000).toISOString(); // +1h

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "Backup1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function scopedEntry(displayName: string, percent = 100): AnthropicLimitEntry {
	return {
		kind: "weekly_scoped",
		group: "weekly",
		percent,
		resets_at: FUTURE_ISO,
		scope: { model: { id: "id", display_name: displayName } },
		is_active: true,
	};
}

function usage(limits: AnthropicLimitEntry[]): AnthropicUsageData {
	return {
		five_hour: { utilization: 0, resets_at: FUTURE_ISO },
		seven_day: { utilization: 83, resets_at: FUTURE_ISO },
		limits,
	};
}

const capacity = (minHeadroom: number): CapacitySignal => ({
	minHeadroom,
	soonestResetMs: null,
	bindingUtilization: 100 - minHeadroom,
	weeklyResetMs: null,
	weeklyHeadroom: 100,
});

describe("resolveFamilyWeeklyExclusion", () => {
	it("excludes an Anthropic account whose requested family is weekly-exhausted with headroom", () => {
		const account = makeAccount();
		const result = resolveFamilyWeeklyExclusion(
			account,
			"claude-fable-5",
			usage([scopedEntry("Fable")]),
			capacity(17),
			NOW,
		);
		expect(result).not.toBeNull();
		expect(result?.family).toBe("fable");
		expect(result?.account.id).toBe("acc-1");
		expect(result?.resetAt).toBe(Date.parse(FUTURE_ISO));
	});

	it("keeps the account for a DIFFERENT family that is not exhausted", () => {
		const result = resolveFamilyWeeklyExclusion(
			makeAccount(),
			"claude-opus-4-8", // Opus, not the exhausted Fable
			usage([scopedEntry("Fable")]),
			capacity(17),
			NOW,
		);
		expect(result).toBeNull();
	});

	it("fails open (null) when capacity is null even if family is exhausted", () => {
		const result = resolveFamilyWeeklyExclusion(
			makeAccount(),
			"claude-fable-5",
			usage([scopedEntry("Fable")]),
			null,
			NOW,
		);
		expect(result).toBeNull();
	});

	it("keeps the account when unified headroom is zero (genuine account-wide limit)", () => {
		const result = resolveFamilyWeeklyExclusion(
			makeAccount(),
			"claude-fable-5",
			usage([scopedEntry("Fable")]),
			capacity(0),
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null when the model resolves to no family", () => {
		const result = resolveFamilyWeeklyExclusion(
			makeAccount(),
			"gpt-5.5",
			usage([scopedEntry("Fable")]),
			capacity(17),
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null when modelForGate is null", () => {
		const result = resolveFamilyWeeklyExclusion(
			makeAccount(),
			null,
			usage([scopedEntry("Fable")]),
			capacity(17),
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null when usage data is null", () => {
		const result = resolveFamilyWeeklyExclusion(
			makeAccount(),
			"claude-fable-5",
			null,
			capacity(17),
			NOW,
		);
		expect(result).toBeNull();
	});
});

describe("createFamilyWeeklyExhaustedResponse", () => {
	const excluded = (
		resetAt: number,
		name = "Backup1",
	): FamilyWeeklyExcludedAccount => ({
		account: makeAccount({ name }),
		family: "fable",
		resetAt,
	});

	it("returns a 429 with Retry-After derived from the soonest reset", () => {
		const soon = NOW + 30_000; // +30s
		const later = NOW + 120_000; // +2m
		const res = createFamilyWeeklyExhaustedResponse(
			[excluded(later, "A"), excluded(soon, "B")],
			"fable",
			"claude-fable-5",
			NOW,
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("30");
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-exhausted",
		);
	});

	it("falls back to the default Retry-After when no future reset is known", () => {
		const res = createFamilyWeeklyExhaustedResponse(
			[excluded(NOW - 5_000)], // reset already in the past
			"fable",
			"claude-fable-5",
			NOW,
		);
		expect(res.headers.get("Retry-After")).toBe("60");
	});

	it("carries a rate_limit_error body naming the family and excluded accounts", async () => {
		const res = createFamilyWeeklyExhaustedResponse(
			[excluded(NOW + 60_000, "Backup1")],
			"fable",
			"claude-fable-5",
			NOW,
		);
		const body = (await res.json()) as {
			type: string;
			error: {
				type: string;
				family: string;
				request_model: string;
				excluded_accounts: Array<{ name: string }>;
			};
		};
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.family).toBe("fable");
		expect(body.error.request_model).toBe("claude-fable-5");
		expect(body.error.excluded_accounts[0].name).toBe("Backup1");
	});

	it("overrides Retry-After with the sibling cooldown (not the 5-day family window)", () => {
		const familyReset = NOW + 5 * 86_400_000; // +5 days
		const siblingReset = NOW + 45_000; // +45s
		const res = createFamilyWeeklyExhaustedResponse(
			[excluded(familyReset, "Main")],
			"fable",
			"claude-fable-5",
			NOW,
			{ name: "Backup1", availableAt: siblingReset },
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe("45");
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-sibling-cooldown",
		);
	});

	it("ignores a sibling cooldown that is already in the past (keeps family behavior)", () => {
		const familyReset = NOW + 30_000; // +30s
		const res = createFamilyWeeklyExhaustedResponse(
			[excluded(familyReset, "Main")],
			"fable",
			"claude-fable-5",
			NOW,
			{ name: "Backup1", availableAt: NOW - 5_000 }, // already recovered
		);
		expect(res.headers.get("Retry-After")).toBe("30");
		expect(res.headers.get("x-clankermux-pool-status")).toBe(
			"family-weekly-exhausted",
		);
	});

	it("names the cooling sibling in the message body", async () => {
		const res = createFamilyWeeklyExhaustedResponse(
			[excluded(NOW + 5 * 86_400_000, "Main")],
			"fable",
			"claude-fable-5",
			NOW,
			{ name: "Backup1", availableAt: NOW + 60_000 },
		);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("Backup1");
		expect(body.error.message).toContain("temporarily");
	});
});

describe("resolveTransientlyCooledFamilySibling", () => {
	// A sibling with the requested family NOT exhausted (Opus at 100, Fable absent).
	const capableUsage = () => usage([scopedEntry("Opus")]);
	// A sibling whose requested family (Fable) IS exhausted.
	const exhaustedUsage = () => usage([scopedEntry("Fable")]);

	it("returns the sibling when Anthropic, family-capable, and on a per-account 429 cooldown", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount({ name: "Backup1" }),
			"fable",
			capableUsage(),
			NOW + 60_000, // rate_limited_until +60s
			null,
			NOW,
		);
		expect(result).not.toBeNull();
		expect(result?.account.name).toBe("Backup1");
		expect(result?.family).toBe("fable");
		expect(result?.availableAt).toBe(NOW + 60_000);
	});

	it("uses the MAX of per-account 429 and provider-overload deadlines", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount(),
			"fable",
			capableUsage(),
			NOW + 30_000, // 429 cooldown
			NOW + 90_000, // provider overload — later
			NOW,
		);
		expect(result?.availableAt).toBe(NOW + 90_000);
	});

	it("returns the sibling on a provider-overload cooldown alone (429 deadline null)", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount(),
			"fable",
			capableUsage(),
			null,
			NOW + 40_000,
			NOW,
		);
		expect(result?.availableAt).toBe(NOW + 40_000);
	});

	it("returns null when the account is NOT on any transient cooldown", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount(),
			"fable",
			capableUsage(),
			null,
			null,
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null when both cooldown deadlines are already in the past", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount(),
			"fable",
			capableUsage(),
			NOW - 1_000,
			NOW - 500,
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null when the requested family IS exhausted on this sibling", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount(),
			"fable",
			exhaustedUsage(), // Fable at 100% → not a capable sibling
			NOW + 60_000,
			null,
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null for a non-Anthropic account (e.g. Codex)", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount({ provider: "codex" }),
			"fable",
			capableUsage(),
			NOW + 60_000,
			null,
			NOW,
		);
		expect(result).toBeNull();
	});

	it("returns null for a paused account", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount({ paused: true }),
			"fable",
			capableUsage(),
			NOW + 60_000,
			null,
			NOW,
		);
		expect(result).toBeNull();
	});

	it("fails toward holding when usage data is missing (cooled, no evidence of family exhaustion)", () => {
		const result = resolveTransientlyCooledFamilySibling(
			makeAccount(),
			"fable",
			null, // no usage data
			NOW + 60_000,
			null,
			NOW,
		);
		expect(result).not.toBeNull();
		expect(result?.availableAt).toBe(NOW + 60_000);
	});
});
