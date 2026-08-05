/**
 * Unit tests for the per-request admission gates extracted out of handleProxy.
 *
 * These exercise `createAdmissionGates` directly — no proxy, no upstream — and
 * pin the contracts that only exist because the gates were closures over one
 * request: the accumulate-and-dedup exclusion lists, the DELIBERATELY frozen
 * combo snapshot behind `modelForAccount`, the LIVE reads of `requestMeta` and
 * the usage-throttle config getters, and the one-partition soft-demotion
 * reorder.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, ComboSlotInfo, RequestMeta } from "@clankermux/types";
import { createAdmissionGates } from "../admission-gates";
import type { ProxyContext } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MODEL = "claude-sonnet-4-5";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
		provider: "anthropic",
		api_key: "key",
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
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
		peak_hours_pause_enabled: false,
		codex_auto_apply_reset_credits_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		...overrides,
	};
}

type ThrottleSwitches = { fiveHour: boolean; weekly: boolean };

function makeConfig(switches: ThrottleSwitches): ProxyContext["config"] {
	return {
		getUsageThrottlingFiveHourEnabled: () => switches.fiveHour,
		getUsageThrottlingWeeklyEnabled: () => switches.weekly,
	} as never;
}

type GateOverrides = {
	requestMeta?: RequestMeta;
	initialComboInfo?: ComboSlotInfo | null;
	effectiveRequestModel?: string | null;
	gateTokenEstimate?: number;
	isSyntheticProbeRequest?: boolean;
	config?: ProxyContext["config"];
};

function makeGates(overrides: GateOverrides = {}) {
	return createAdmissionGates({
		requestMeta: overrides.requestMeta ?? makeRequestMeta(),
		initialComboInfo: overrides.initialComboInfo ?? null,
		effectiveRequestModel:
			overrides.effectiveRequestModel === undefined
				? MODEL
				: overrides.effectiveRequestModel,
		gateTokenEstimate: overrides.gateTokenEstimate ?? 1_000,
		isSyntheticProbeRequest: overrides.isSyntheticProbeRequest ?? false,
		config: overrides.config ?? makeConfig({ fiveHour: false, weekly: false }),
	});
}

/** Fresh usage for the soft-demotion gate: utilization percentages per window. */
function seedUsage(
	accountId: string,
	fiveHour: number,
	weekly: number,
	weeklyResetInMs = 5 * DAY,
) {
	usageCache.set(accountId, {
		five_hour: {
			utilization: fiveHour,
			resets_at: new Date(Date.now() + 4 * HOUR).toISOString(),
		},
		seven_day: {
			utilization: weekly,
			resets_at: new Date(Date.now() + weeklyResetInMs).toISOString(),
		},
	} as never);
}

/**
 * A 5-hour window that is ~3h into its 5h span at 99% utilization: far ahead of
 * the ~60% the elapsed time justifies, so the usage-throttle gate holds it back.
 */
function seedThrottled(accountId: string) {
	usageCache.set(accountId, {
		five_hour: {
			utilization: 99,
			resets_at: new Date(Date.now() + 2 * HOUR).toISOString(),
		},
		seven_day: { utilization: 10, resets_at: null },
	} as never);
}

const SEEDED_IDS = ["acc-1", "acc-a", "acc-b", "acc-c", "acc-d", "codex-1"];

describe("createAdmissionGates", () => {
	const reset = () => {
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		for (const id of SEEDED_IDS) usageCache.delete(id);
	};

	beforeEach(reset);
	afterEach(reset);

	describe("(a) exclusion accumulators dedup across passes", () => {
		it("records a context-window exclusion once even when the gate runs twice", () => {
			// gpt-5.3-codex-spark's 128K window (threshold 124160) can't hold 150K.
			const codex = makeAccount({
				id: "codex-1",
				name: "codex-1",
				provider: "codex",
				model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex-spark" }),
			});
			const gates = makeGates({ gateTokenEstimate: 150_000 });

			expect(gates.applyContextWindowGate([codex])).toEqual([]);
			expect(gates.applyContextWindowGate([codex])).toEqual([]);

			expect(gates.contextExcludedAccounts).toHaveLength(1);
			expect(gates.contextExcludedAccounts[0].account.id).toBe("codex-1");
			expect(gates.contextExcludedAccounts[0].model).toBe(MODEL);
		});
	});

	describe("(b) requestMeta is read LIVE, not snapshotted", () => {
		it("stops applying slot overrides once requestMeta.comboName is cleared", () => {
			const account = makeAccount({ id: "acc-a" });
			const requestMeta = makeRequestMeta({ comboName: "combo-x" });
			const gates = makeGates({
				requestMeta,
				initialComboInfo: {
					comboName: "combo-x",
					slots: [{ accountId: "acc-a", modelOverride: "claude-opus-4-5" }],
				},
			});

			expect(gates.modelForAccount(account)).toBe("claude-opus-4-5");

			// The combo-fallback path nulls comboName on the SAME meta object.
			requestMeta.comboName = null;
			expect(gates.modelForAccount(account)).toBe(MODEL);
		});
	});

	describe("(c) combo requests skip the soft-demotion reorder", () => {
		it("returns the candidate order untouched when combo info is present", () => {
			const a = makeAccount({ id: "acc-a", name: "a" });
			const b = makeAccount({ id: "acc-b", name: "b" });
			// Usage that WOULD demote `a` on the non-combo path.
			seedUsage("acc-a", 0, 95);
			seedUsage("acc-b", 20, 20);
			const gates = makeGates();

			const candidates = [a, b];
			const reordered = gates.applySoftDemotionReorder(candidates, {
				slots: [{ accountId: "acc-a", modelOverride: MODEL }],
			});

			expect(reordered).toBe(candidates);
			expect(gates.softDemotionReasons.size).toBe(0);
			// Sanity: without the combo the same input DOES reorder.
			expect(
				gates.applySoftDemotionReorder(candidates).map((x) => x.id),
			).toEqual(["acc-b", "acc-a"]);
		});
	});

	describe("(d) the reorder is ONE partition over the union of both reasons", () => {
		it("emits [kept…, demoted…] with the input order preserved inside each side", () => {
			const a = makeAccount({ id: "acc-a", name: "a" });
			const b = makeAccount({ id: "acc-b", name: "b" });
			const c = makeAccount({ id: "acc-c", name: "c" });
			const d = makeAccount({ id: "acc-d", name: "d" });
			// a and c sit in the weekly reserve tail; b and d can absorb.
			seedUsage("acc-a", 0, 95);
			seedUsage("acc-b", 20, 20);
			seedUsage("acc-c", 0, 95);
			seedUsage("acc-d", 20, 20);
			const gates = makeGates();

			const reordered = gates.applySoftDemotionReorder([a, b, c, d]);

			expect(reordered.map((x) => x.id)).toEqual([
				"acc-b",
				"acc-d",
				"acc-a",
				"acc-c",
			]);
			// Nothing is ever dropped by this gate.
			expect(reordered).toHaveLength(4);
			expect(gates.softDemotionReasons.get("acc-a")).toBe("pool liveness");
			expect(gates.softDemotionReasons.get("acc-c")).toBe("pool liveness");
			expect(gates.softDemotionReasons.has("acc-b")).toBe(false);
			expect(gates.softDemotionReasons.has("acc-d")).toBe(false);
		});
	});

	describe("(e) modelForAccount family-resolvability fallback", () => {
		it("falls back to the logical model when the mapped model resolves to no family", () => {
			const mapped = makeAccount({
				id: "acc-a",
				model_mappings: JSON.stringify({ sonnet: "qwen/qwen3-coder" }),
			});
			expect(makeGates().modelForAccount(mapped)).toBe(MODEL);
		});

		it("keeps the mapped model when it DOES resolve to a family", () => {
			const mapped = makeAccount({
				id: "acc-a",
				model_mappings: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
			});
			expect(makeGates().modelForAccount(mapped)).toBe("claude-haiku-4-5");
		});

		it("returns null when there is no logical model at all", () => {
			expect(
				makeGates({ effectiveRequestModel: null }).modelForAccount(
					makeAccount({ id: "acc-a" }),
				),
			).toBeNull();
		});
	});

	describe("(f) usage-throttle config getters are read LIVE per call", () => {
		it("honors a switch flipped between two calls on the SAME instance", () => {
			const account = makeAccount({ id: "acc-a" });
			seedThrottled("acc-a");
			const switches: ThrottleSwitches = { fiveHour: false, weekly: false };
			const gates = makeGates({ config: makeConfig(switches) });

			const first = gates.applyUsageThrottling([account]);
			expect(first.available.map((a) => a.id)).toEqual(["acc-a"]);
			expect(first.throttled).toEqual([]);

			switches.fiveHour = true;

			const second = gates.applyUsageThrottling([account]);
			expect(second.available).toEqual([]);
			expect(second.throttled.map((a) => a.id)).toEqual(["acc-a"]);
		});

		it("exempts a trusted synthetic probe regardless of the switches", () => {
			const account = makeAccount({ id: "acc-a" });
			seedThrottled("acc-a");
			const gates = makeGates({
				isSyntheticProbeRequest: true,
				config: makeConfig({ fiveHour: true, weekly: true }),
			});

			const result = gates.applyUsageThrottling([account]);
			expect(result.available.map((a) => a.id)).toEqual(["acc-a"]);
			expect(result.throttled).toEqual([]);
		});
	});

	describe("(g) softDemotionReasons tracks the LATEST reorder", () => {
		it("is rebuilt from scratch on every call", () => {
			const a = makeAccount({ id: "acc-a", name: "a" });
			const b = makeAccount({ id: "acc-b", name: "b" });
			seedUsage("acc-a", 0, 95);
			seedUsage("acc-b", 20, 20);
			const gates = makeGates();

			expect(gates.applySoftDemotionReorder([a, b]).map((x) => x.id)).toEqual([
				"acc-b",
				"acc-a",
			]);
			expect(gates.softDemotionReasons.get("acc-a")).toBe("pool liveness");

			// `a` is no longer in the reserve tail — the second reorder must forget it.
			seedUsage("acc-a", 20, 20);
			expect(gates.applySoftDemotionReorder([a, b]).map((x) => x.id)).toEqual([
				"acc-a",
				"acc-b",
			]);
			expect(gates.softDemotionReasons.size).toBe(0);
		});
	});

	describe("(h) the combo snapshot behind modelForAccount is frozen", () => {
		it("ignores combo info handed to a LATER gate call", () => {
			const account = makeAccount({ id: "acc-a" });
			const requestMeta = makeRequestMeta({ comboName: "combo-x" });
			const gates = makeGates({
				requestMeta,
				initialComboInfo: {
					comboName: "combo-x",
					slots: [{ accountId: "acc-a", modelOverride: "claude-opus-4-5" }],
				},
			});

			// A hold wake re-runs the CW / family gates with FRESH combo info …
			const wakeComboInfo = {
				slots: [{ accountId: "acc-a", modelOverride: "claude-haiku-4-5" }],
			};
			expect(gates.applyContextWindowGate([account], wakeComboInfo)).toEqual([
				account,
			]);
			expect(gates.applyFamilyWeeklyGate([account], wakeComboInfo)).toEqual([
				account,
			]);

			// … while modelForAccount keeps the CONSTRUCTION-time snapshot. Existing
			// behavior, pinned deliberately rather than "fixed".
			expect(gates.modelForAccount(account)).toBe("claude-opus-4-5");
		});
	});
});
