import { installGateRoute } from "./fixtures/gate-routing";
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
import { SessionStrategy } from "@clankermux/load-balancer";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { createAdmissionGates as makeAdmissionGates } from "../admission-gates";
import {
	recordCodexTransientFailure,
	resetCodexTransientHealthForTests,
} from "../codex-transient-health";
import {
	recordFamilyWeeklyExhausted,
	resetFamilyWeeklyMemoForTests,
} from "../family-weekly-memo";
import type { ProxyContext } from "../handlers";
import { resetRateLimitProbeGatesForTests } from "../handlers/rate-limit-cooldown";
import { clearProviderOverloadCooldown } from "../provider-overload-cooldown";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MODEL = "claude-sonnet-4-5";

const gateAccounts = new Map<string, Account>();
const gateTargets = new Map<string, string>();
beforeEach(() => {
	gateAccounts.clear();
	gateTargets.clear();
});
function makeAccount(
	overrides: Partial<Account> & { resolvedModel?: string } = {},
): Account {
	const account = {
		id: "acc-1",
		name: "account",
		provider: "anthropic",
		api_key: "key",
		refresh_token: "",
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
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	} as Account;
	gateAccounts.set(account.id, account);
	if (overrides.resolvedModel)
		gateTargets.set(account.id, overrides.resolvedModel);
	return account;
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
	requestModel?: string;
	gateTokenEstimate?: number;
	isSyntheticProbeRequest?: boolean;
	config?: ProxyContext["config"];
};

/** The gates read the frozen route, so install one for the model under test. */
function createAdmissionGates(
	input: Parameters<typeof makeAdmissionGates>[0],
	requestModel: string,
) {
	const gates = makeAdmissionGates(input);
	return new Proxy(gates, {
		get(target, key) {
			const value = Reflect.get(target, key);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				installGateRoute(
					input.requestMeta,
					[...gateAccounts.values()],
					requestModel,
					gateTargets,
				);
				return value(...args);
			};
		},
	});
}

function makeGates(overrides: GateOverrides = {}) {
	return createAdmissionGates(
		{
			requestMeta: overrides.requestMeta ?? makeRequestMeta(),
			gateTokenEstimate: overrides.gateTokenEstimate ?? 1_000,
			isSyntheticProbeRequest: overrides.isSyntheticProbeRequest ?? false,
			config:
				overrides.config ?? makeConfig({ fiveHour: false, weekly: false }),
		},
		overrides.requestModel ?? MODEL,
	);
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

/**
 * An account whose FABLE weekly window is far ahead of an even pace (80% used
 * two days into a 7-day window) while every account-wide window is fine, which
 * is what family-aware weekly pacing exists to catch.
 */
function seedFamilyOverpace(accountId: string, percent = 80) {
	const resetsAt = new Date(Date.now() + 5 * DAY).toISOString();
	usageCache.set(accountId, {
		five_hour: {
			utilization: 10,
			resets_at: new Date(Date.now() + 4 * HOUR).toISOString(),
		},
		seven_day: { utilization: 10, resets_at: resetsAt },
		limits: [
			{
				kind: "weekly_scoped",
				group: "weekly",
				percent,
				resets_at: resetsAt,
				scope: { model: { id: "fable", display_name: "Fable" } },
				is_active: true,
			},
		],
	} as never);
}

const SEEDED_IDS = ["acc-1", "acc-a", "acc-b", "acc-c", "acc-d", "codex-1"];

describe("createAdmissionGates", () => {
	const reset = () => {
		clearProviderOverloadCooldown();
		resetRateLimitProbeGatesForTests();
		resetFamilyWeeklyMemoForTests();
		resetCodexTransientHealthForTests();
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
				resolvedModel: "gpt-5.3-codex-spark",
			});
			const gates = makeGates({ gateTokenEstimate: 150_000 });

			expect(gates.applyContextWindowGate([codex])).toEqual([]);
			expect(gates.applyContextWindowGate([codex])).toEqual([]);

			expect(gates.contextExcludedAccounts).toHaveLength(1);
			expect(gates.contextExcludedAccounts[0].account.id).toBe("codex-1");
			expect(gates.contextExcludedAccounts[0].model).toBe(
				"gpt-5.3-codex-spark",
			);
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

	describe("family-weekly PACING", () => {
		it("drops a paced account and records it under familyWeeklyPacedAccounts", () => {
			const account = makeAccount();
			seedFamilyOverpace(account.id);
			const gates = makeGates({
				requestModel: "claude-fable-5",
				config: makeConfig({ fiveHour: false, weekly: true }),
			});

			expect(gates.applyFamilyWeeklyGate([account])).toEqual([]);
			expect(gates.familyWeeklyPacedAccounts).toHaveLength(1);
			expect(gates.familyWeeklyPacedAccounts[0].account.id).toBe(account.id);
			expect(gates.familyWeeklyPacedAccounts[0].family).toBe("fable");
			// Pacing is throttle evidence, NOT exhaustion: putting it in the
			// exclusion list would fire the family-exhausted 429 with its
			// multi-day Retry-After.
			expect(gates.familyWeeklyExcludedAccounts).toEqual([]);
		});

		it("keeps the account when weekly throttling is disabled", () => {
			const account = makeAccount();
			seedFamilyOverpace(account.id);
			const gates = makeGates({
				requestModel: "claude-fable-5",
				config: makeConfig({ fiveHour: true, weekly: false }),
			});

			expect(gates.applyFamilyWeeklyGate([account])).toEqual([account]);
			expect(gates.familyWeeklyPacedAccounts).toEqual([]);
		});

		it("never paces a synthetic probe request", () => {
			const account = makeAccount();
			seedFamilyOverpace(account.id);
			const gates = makeGates({
				requestModel: "claude-fable-5",
				isSyntheticProbeRequest: true,
				config: makeConfig({ fiveHour: true, weekly: true }),
			});

			expect(gates.applyFamilyWeeklyGate([account])).toEqual([account]);
			expect(gates.familyWeeklyPacedAccounts).toEqual([]);
		});

		it("does not pace a request for a DIFFERENT family on the same account", () => {
			const account = makeAccount();
			seedFamilyOverpace(account.id);
			const gates = makeGates({
				requestModel: "claude-opus-4-8",
				config: makeConfig({ fiveHour: false, weekly: true }),
			});

			expect(gates.applyFamilyWeeklyGate([account])).toEqual([account]);
			expect(gates.familyWeeklyPacedAccounts).toEqual([]);
		});

		it("dedups a paced account across gate passes", () => {
			const account = makeAccount();
			seedFamilyOverpace(account.id);
			const gates = makeGates({
				requestModel: "claude-fable-5",
				config: makeConfig({ fiveHour: false, weekly: true }),
			});

			gates.applyFamilyWeeklyGate([account]);
			gates.applyFamilyWeeklyGate([account]);

			expect(gates.familyWeeklyPacedAccounts).toHaveLength(1);
		});
	});

	describe("family-weekly 429-learned memo demotion", () => {
		const FABLE = "claude-fable-5";

		const memo = (id: string, resetInMs = 4 * HOUR) =>
			recordFamilyWeeklyExhausted(
				id,
				"fable",
				Date.now() + resetInMs,
				Date.now(),
			);

		it("sorts an account the memo marks exhausted behind its healthy siblings", () => {
			const account = makeAccount({ id: "acc-a" });
			const other = makeAccount({ id: "acc-b" });
			memo("acc-a");

			const gates = makeGates({ requestModel: FABLE });

			// Demoted, not dropped: the healthy sibling is what gets asked, while
			// the refused account stays available as a last resort.
			expect(
				gates.applyFailureMemoDemotion([account, other]).map((a) => a.id),
			).toEqual(["acc-b", "acc-a"]);
		});

		// The reactive rung deliberately withholds an account-wide cooldown so the
		// account keeps serving its other families. A memo that sidelined the whole
		// account would silently undo that.
		it("leaves the account's other families in front", () => {
			const account = makeAccount({ id: "acc-a" });
			const other = makeAccount({ id: "acc-b" });
			memo("acc-a");

			const gates = makeGates({ requestModel: MODEL });

			expect(
				gates.applyFailureMemoDemotion([account, other]).map((a) => a.id),
			).toEqual(["acc-a", "acc-b"]);
		});

		it("stops demoting once the remembered window has reset", async () => {
			const account = makeAccount({ id: "acc-a" });
			const other = makeAccount({ id: "acc-b" });
			memo("acc-a", 40);

			const gates = makeGates({ requestModel: FABLE });
			expect(
				gates.applyFailureMemoDemotion([account, other]).map((a) => a.id),
			).toEqual(["acc-b", "acc-a"]);

			await Bun.sleep(60);
			expect(
				gates.applyFailureMemoDemotion([account, other]).map((a) => a.id),
			).toEqual(["acc-a", "acc-b"]);
		});

		// The memo is inferred state and other gates drop candidates of their own,
		// so it must never shrink the pool — otherwise a stale entry can empty it
		// by proxy and strand the request on a terminal no upstream asked for.
		it("never removes a candidate, even when every account is memo'd", () => {
			const a = makeAccount({ id: "acc-a" });
			const b = makeAccount({ id: "acc-b" });
			memo("acc-a");
			memo("acc-b");

			const gates = makeGates({ requestModel: FABLE });

			expect(gates.applyFailureMemoDemotion([a, b]).map((x) => x.id)).toEqual([
				"acc-a",
				"acc-b",
			]);
		});

		it("keeps a memo'd account when it is the only candidate", () => {
			const account = makeAccount({ id: "acc-a" });
			memo("acc-a");

			const gates = makeGates({ requestModel: FABLE });

			expect(gates.applyFailureMemoDemotion([account])).toEqual([account]);
		});

		// Demoted accounts are still in the pool, so they must not appear in the
		// list the zero-accounts terminals report as the reason for failure.
		it("does not record demoted accounts as excluded", () => {
			const account = makeAccount({ id: "acc-a" });
			const other = makeAccount({ id: "acc-b" });
			memo("acc-a");

			const gates = makeGates({ requestModel: FABLE });
			gates.applyFailureMemoDemotion([account, other]);

			expect(gates.familyWeeklyExcludedAccounts).toHaveLength(0);
		});

		it("ignores the memo for non-Anthropic accounts", () => {
			const codex = makeAccount({ id: "codex-1", provider: "codex" });
			memo("codex-1");

			const gates = makeGates({ requestModel: FABLE });

			expect(gates.applyFailureMemoDemotion([codex])).toEqual([codex]);
		});

		// A literal routing rule points this account at a DIFFERENT family from the
		// one the client asked for, so the memo that governs it is the RESOLVED
		// target's. Under identity routing the two coincide and the distinction is
		// invisible, which is why this case needs a literal target.
		it("demotes on the RESOLVED target's family, not the requested one", () => {
			const mapped = makeAccount({
				id: "acc-a",
				name: "a",
				resolvedModel: FABLE,
			});
			const other = makeAccount({
				id: "acc-b",
				name: "b",
				resolvedModel: FABLE,
			});
			memo("acc-a");

			// Requested family is sonnet; the memo is on fable, the family acc-a
			// will actually serve.
			const gates = makeGates({ requestModel: MODEL });

			expect(
				gates.applyFailureMemoDemotion([mapped, other]).map((a) => a.id),
			).toEqual(["acc-b", "acc-a"]);
		});

		it("ignores a memo for the REQUESTED family the account will never serve", () => {
			const mapped = makeAccount({
				id: "acc-a",
				name: "a",
				resolvedModel: FABLE,
			});
			const other = makeAccount({
				id: "acc-b",
				name: "b",
				resolvedModel: FABLE,
			});
			recordFamilyWeeklyExhausted(
				"acc-a",
				"sonnet",
				Date.now() + 4 * HOUR,
				Date.now(),
			);

			const gates = makeGates({ requestModel: MODEL });

			// Untouched — identity, which is what "nothing was demoted" looks like.
			const candidates = [mapped, other];
			expect(gates.applyFailureMemoDemotion(candidates)).toBe(candidates);
		});

		it("returns the candidate list untouched when nothing is memo'd", () => {
			const a = makeAccount({ id: "acc-a" });
			const b = makeAccount({ id: "acc-b" });
			const gates = makeGates({ requestModel: FABLE });
			const candidates = [a, b];

			expect(gates.applyFailureMemoDemotion(candidates)).toBe(candidates);
		});

		// Combo slots are positional; reordering desyncs the account-to-slot
		// mapping, which is why the soft reorder skips combos too.

		it("survives a soft-demotion reorder that would otherwise promote it", () => {
			const memod = makeAccount({ id: "acc-a", name: "a" });
			const healthy = makeAccount({ id: "acc-b", name: "b" });
			// acc-b sits in the weekly reserve tail, so the soft reorder demotes it
			// while leaving acc-a in front.
			seedUsage("acc-a", 0, 10);
			seedUsage("acc-b", 0, 95);
			memo("acc-a");

			const gates = makeGates({ requestModel: FABLE });

			const softReordered = gates.applySoftDemotionReorder([memod, healthy]);
			expect(softReordered.map((a) => a.id)).toEqual(["acc-a", "acc-b"]);

			// Applied last, the memo still wins: the refused account ends up behind.
			expect(
				gates.applyFailureMemoDemotion(softReordered).map((a) => a.id),
			).toEqual(["acc-b", "acc-a"]);
		});
	});

	describe("header-fed usage", () => {
		const polled: string[] = [];
		afterEach(() => {
			for (const id of polled.splice(0)) usageCache.stopPolling(id);
		});
		const fiveReset = () => Math.floor((Date.now() + 4 * HOUR) / 1000) * 1000;
		const weekReset = () => Math.floor((Date.now() + 5 * DAY) / 1000) * 1000;

		/** A poll reading written `ageMs` ago, with an optional Fable limit. */
		function seedPoll(
			id: string,
			ageMs: number,
			fivePct: number,
			weekPct: number,
			fablePct: number | null = null,
		) {
			usageCache.setWithAgeForTests(
				id,
				{
					five_hour: {
						utilization: fivePct,
						resets_at: new Date(fiveReset()).toISOString(),
					},
					seven_day: {
						utilization: weekPct,
						resets_at: new Date(weekReset()).toISOString(),
					},
					...(fablePct === null
						? {}
						: {
								limits: [
									{
										kind: "weekly_scoped",
										group: "weekly",
										percent: fablePct,
										resets_at: new Date(weekReset()).toISOString(),
										scope: { model: { id: "fable", display_name: "Fable" } },
										is_active: true,
									},
								],
							}),
				} as never,
				ageMs,
			);
		}

		/** Headers of a response that arrived just now, under a live poller. */
		function feedHeaders(id: string, fivePct: number, weekPct: number) {
			if (usageCache.usageHeaderEpoch(id) === null) {
				polled.push(id);
				usageCache.startPolling(
					id,
					async () => "token",
					"anthropic",
					90_000,
					null,
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					{ initialDelayMs: 10 * HOUR },
				);
			}
			usageCache.recordUsageHeaders(
				id,
				usageCache.usageHeaderEpoch(id),
				[
					{
						claim: "5h",
						status: "allowed",
						utilization: fivePct / 100,
						resetMs: fiveReset(),
						surpassedThreshold: null,
					},
					{
						claim: "7d",
						status: "allowed",
						utilization: weekPct / 100,
						resetMs: weekReset(),
						surpassedThreshold: null,
					},
				],
				Date.now(),
			);
		}

		it("the family gate and soft demotions leave a stale poll entry in place", () => {
			const a = makeAccount({ id: "acc-a", name: "a" });
			const b = makeAccount({ id: "acc-b", name: "b" });
			seedPoll("acc-a", 11 * 60_000, 10, 10, 100);
			seedUsage("acc-b", 20, 20);
			const gates = makeGates({ requestModel: "claude-fable-5" });

			gates.applyFamilyWeeklyGate([a, b]);
			gates.applySoftDemotionReorder([a, b]);

			expect(usageCache.peekAge("acc-a")).not.toBeNull();
		});

		it("header readings never make a stale poll count for the family gate", () => {
			const account = makeAccount({ id: "acc-a" });
			feedHeaders("acc-a", 10, 10);
			seedPoll("acc-a", 200_000, 10, 10, 100);
			const gates = makeGates({ requestModel: "claude-fable-5" });

			// Past the 180s bound the poll-only gate fails open, however fresh the
			// headers are.
			expect(gates.applyFamilyWeeklyGate([account])).toEqual([account]);
			expect(gates.familyWeeklyExcludedAccounts).toEqual([]);
		});

		it("header readings never change a family exclusion on a fresh poll", () => {
			const account = makeAccount({ id: "acc-a" });
			// A spent account-wide pair would void the "headroom present" half of the
			// exclusion if the gate read it.
			feedHeaders("acc-a", 100, 100);
			seedPoll("acc-a", 60_000, 10, 10, 100);
			const gates = makeGates({ requestModel: "claude-fable-5" });

			expect(gates.applyFamilyWeeklyGate([account])).toEqual([]);
			expect(gates.familyWeeklyExcludedAccounts).toHaveLength(1);
		});

		it("the liveness reserve reads a fresh header weekly over a stale poll", () => {
			const a = makeAccount({ id: "acc-a", name: "a" });
			const b = makeAccount({ id: "acc-b", name: "b" });
			feedHeaders("acc-a", 0, 95);
			seedPoll("acc-a", 400_000, 0, 20);
			seedUsage("acc-b", 20, 20);
			const gates = makeGates();

			expect(gates.applySoftDemotionReorder([a, b]).map((x) => x.id)).toEqual([
				"acc-b",
				"acc-a",
			]);
			expect(gates.softDemotionReasons.get("acc-a")).toBe("pool liveness");
		});

		it("usage throttling reads a fresh header 5h over an older poll", () => {
			const account = makeAccount({ id: "acc-a" });
			feedHeaders("acc-a", 99, 10);
			seedPoll("acc-a", 300_000, 20, 10);
			const gates = makeGates({
				config: makeConfig({ fiveHour: true, weekly: false }),
			});

			expect(gates.applyUsageThrottling([account]).throttled).toEqual([
				account,
			]);
		});
	});

	describe("transient Codex failure demotion", () => {
		it("partitions both failure reasons together and preserves an entirely demoted pool", () => {
			const codex = makeAccount({ id: "codex-1", provider: "codex" });
			const claude = makeAccount({ id: "acc-a" });
			const healthy = makeAccount({ id: "acc-b" });
			recordCodexTransientFailure(codex.id);
			recordFamilyWeeklyExhausted(
				claude.id,
				"sonnet",
				Date.now() + HOUR,
				Date.now(),
			);
			const gates = makeGates();
			expect(gates.applyFailureMemoDemotion([codex, claude, healthy])).toEqual([
				healthy,
				codex,
				claude,
			]);
			expect(gates.applyFailureMemoDemotion([codex, claude])).toEqual([
				codex,
				claude,
			]);
			expect(gates.applyFailureMemoDemotion([claude, codex])).toEqual([
				claude,
				codex,
			]);
			expect(gates.applyFailureMemoDemotion([codex])).toEqual([codex]);
		});

		it("ignores expired hints and leaves synthetic selections alone", () => {
			const first = makeAccount({ id: "codex-1", provider: "codex" });
			const second = makeAccount({ id: "codex-2", provider: "codex" });
			recordCodexTransientFailure(first.id, Date.now() - 60_001);
			expect(makeGates().applyFailureMemoDemotion([first, second])).toEqual([
				first,
				second,
			]);
			recordCodexTransientFailure(first.id);
			expect(
				makeGates({ isSyntheticProbeRequest: true }).applyFailureMemoDemotion([
					first,
					second,
				]),
			).toEqual([first, second]);
		});
	});

	describe("affinity follows a pool-liveness demotion once the peer serves", () => {
		const sessionTurn = (model?: string) =>
			makeRequestMeta({
				affinityKey: "pi-conversation",
				affinityScope: "client_session",
				affinityModel: model ?? null,
			});
		// One request through the order the proxy applies: strategy, soft
		// reorder, failure memos last, affinity reconciliation, then the follow
		// callback for whichever account served.
		const route = (
			strategy: SessionStrategy,
			accounts: Account[],
			options: {
				served?: string;
				isSyntheticProbeRequest?: boolean;
				path?: string;
				model?: string;
			} = {},
		) => {
			const meta = sessionTurn(options.model);
			if (options.path) meta.path = options.path;
			const gates = createAdmissionGates(
				{
					requestMeta: meta,
					gateTokenEstimate: 1,
					isSyntheticProbeRequest: options.isSyntheticProbeRequest ?? false,
					config: makeConfig({ fiveHour: false, weekly: false }),
					strategy,
				},
				options.model ?? MODEL,
			);
			const candidates = gates.applyFailureMemoDemotion(
				gates.applySoftDemotionReorder(strategy.select(accounts, meta)),
			);
			gates.reconcileAffinity(candidates);
			const follow = gates.prepareSoftDemotionFollow(candidates);
			const served =
				candidates.find((a) => a.id === options.served) ?? candidates[0];
			follow?.(served);
			return { meta, candidates, follow };
		};
		const pinnedTo = (
			strategy: SessionStrategy,
			accounts: Account[],
			model?: string,
		) => {
			const meta = sessionTurn(model);
			const selected = strategy.select(accounts, meta);
			expect(meta.routing?.decision).toBe("affinity_hit");
			return selected[0].id;
		};
		const pool = () => [
			makeAccount({ id: "acc-a", name: "a", priority: 0 }),
			makeAccount({ id: "acc-b", name: "b", priority: 1 }),
			makeAccount({ id: "acc-c", name: "c", priority: 2 }),
		];
		const reserveTheStrategysPick = () => {
			seedUsage("acc-a", 0, 95);
			seedUsage("acc-b", 20, 20);
			seedUsage("acc-c", 20, 20);
		};

		it("moves the pin to the reorder's head once it serves, and keeps it there", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			reserveTheStrategysPick();

			const first = route(strategy, accounts);
			expect(first.candidates[0].id).toBe("acc-b");
			// Telemetry keeps the strategy's own decision.
			expect(first.meta.routing?.decision).toBe("affinity_miss");

			// The reserve lifts: the conversation stays where its cache is.
			seedUsage("acc-a", 0, 10);
			expect(pinnedTo(strategy, accounts)).toBe("acc-b");
		});

		it("leaves the pin when another account served the request", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			reserveTheStrategysPick();

			route(strategy, accounts, { served: "acc-c" });

			seedUsage("acc-a", 0, 10);
			expect(pinnedTo(strategy, accounts)).toBe("acc-a");
		});

		it("does not follow a head that a failure memo pushed back", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			reserveTheStrategysPick();
			recordFamilyWeeklyExhausted(
				"acc-b",
				"sonnet",
				Date.now() + HOUR,
				Date.now(),
			);

			// acc-b serves only after acc-c and acc-a fail.
			const { candidates, follow } = route(strategy, accounts, {
				served: "acc-b",
			});
			expect(candidates.map((a) => a.id)).toEqual(["acc-c", "acc-a", "acc-b"]);
			expect(follow).toBeNull();
		});

		it("leaves the pin when only a failure memo moved the request", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			seedUsage("acc-a", 0, 10);
			seedUsage("acc-b", 20, 20);
			recordFamilyWeeklyExhausted(
				"acc-a",
				"sonnet",
				Date.now() + HOUR,
				Date.now(),
			);

			const { candidates, follow } = route(strategy, accounts);
			expect(candidates[0].id).toBe("acc-b");
			expect(follow).toBeNull();
		});

		it("without a model stamp, never follows a family reservation", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			// A near-full shared 5h window reserves acc-a for Fable against this
			// Sonnet request only.
			seedUsage("acc-a", 99, 10);
			seedUsage("acc-b", 20, 20);
			seedUsage("acc-c", 20, 20);

			const { candidates, follow } = route(strategy, accounts);
			expect(candidates[0].id).toBe("acc-b");
			expect(follow).toBeNull();
		});

		it("without a model stamp, never follows a reserve that only the request's own tier imposes", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			// 85% used: inside the ordinary 20% reserve, outside Fable's 10%.
			seedUsage("acc-a", 0, 85);
			seedUsage("acc-b", 20, 20);
			seedUsage("acc-c", 20, 20);

			const { candidates, follow } = route(strategy, accounts);
			expect(candidates[0].id).toBe("acc-b");
			expect(follow).toBeNull();
		});

		it("ignores token counts, which the proxy may answer itself", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			reserveTheStrategysPick();

			const { follow } = route(strategy, accounts, {
				path: "/v1/messages/count_tokens",
			});
			expect(follow).toBeNull();
		});

		it("does not overwrite a pin that moved while the request was in flight", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			reserveTheStrategysPick();
			const meta = sessionTurn();
			const gates = createAdmissionGates(
				{
					requestMeta: meta,
					gateTokenEstimate: 1,
					isSyntheticProbeRequest: false,
					config: makeConfig({ fiveHour: false, weekly: false }),
					strategy,
				},
				MODEL,
			);
			const candidates = gates.applyFailureMemoDemotion(
				gates.applySoftDemotionReorder(strategy.select(accounts, meta)),
			);
			const follow = gates.prepareSoftDemotionFollow(candidates);
			expect(follow).not.toBeNull();

			// A concurrent turn on the same conversation moves it to acc-c.
			const concurrent = sessionTurn();
			strategy.select(accounts, concurrent);
			strategy.reassignAffinity(concurrent, accounts[2]);

			follow?.(candidates[0]);
			seedUsage("acc-a", 0, 10);
			expect(pinnedTo(strategy, accounts)).toBe("acc-c");
		});

		it("never follows to another provider", () => {
			const accounts = [
				makeAccount({ id: "acc-a", name: "a", priority: 0 }),
				makeAccount({
					id: "codex-1",
					name: "codex",
					provider: "codex",
					priority: 1,
					resolvedModel: "gpt-6-astra",
				}),
				makeAccount({ id: "acc-c", name: "c", priority: 2 }),
			];
			const strategy = new SessionStrategy();
			seedUsage("acc-a", 0, 95);
			seedUsage("acc-c", 20, 20);

			const { candidates, follow } = route(strategy, accounts);
			expect(candidates[0].id).toBe("codex-1");
			expect(follow).toBeNull();
		});

		it("does not follow while the pinned account is on a transient hold", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			seedUsage("acc-b", 20, 20);
			seedUsage("acc-c", 20, 20);
			route(strategy, accounts); // pins acc-a

			accounts[0].rate_limited_until = Date.now() + 60_000;
			seedUsage("acc-a", 0, 95);
			const held = route(strategy, accounts);
			expect(held.meta.routing?.decision).toBe("affinity_hold");
			expect(held.follow).toBeNull();
		});

		it("ignores synthetic probe requests", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			reserveTheStrategysPick();

			const { follow } = route(strategy, accounts, {
				isSyntheticProbeRequest: true,
			});
			expect(follow).toBeNull();
		});

		it("keeps the pin when no peer can absorb its traffic", () => {
			const accounts = pool();
			const strategy = new SessionStrategy();
			seedUsage("acc-a", 0, 95);
			seedUsage("acc-b", 0, 95);
			seedUsage("acc-c", 0, 95);

			const { candidates, follow } = route(strategy, accounts);
			expect(candidates[0].id).toBe("acc-a");
			expect(follow).toBeNull();
		});

		describe("with a per-model pin", () => {
			const FABLE = "claude-fable-5";

			it.each([
				// A near-full shared 5h window reserves acc-a for Fable.
				["family reservation", 99, 10],
				// 85% used: inside the ordinary 20% reserve, outside Fable's 10%.
				["pool liveness at the request's own tier", 0, 85],
				["pool liveness at every tier", 0, 95],
				["both", 99, 95],
			] as const)("follows %s, moving only this model's pin", (_reason, fiveHour, weekly) => {
				const accounts = pool();
				const strategy = new SessionStrategy();
				seedUsage("acc-a", fiveHour, weekly);
				seedUsage("acc-b", 20, 20);
				seedUsage("acc-c", 20, 20);
				// The conversation starts on acc-a with its Fable turns.
				usageCache.delete("acc-a");
				route(strategy, accounts, { model: FABLE });
				seedUsage("acc-a", fiveHour, weekly);

				const { candidates, follow } = route(strategy, accounts, {
					model: MODEL,
				});
				expect(candidates[0].id).toBe("acc-b");
				expect(follow).not.toBeNull();

				seedUsage("acc-a", 0, 10);
				expect(pinnedTo(strategy, accounts, MODEL)).toBe("acc-b");
				expect(pinnedTo(strategy, accounts, FABLE)).toBe("acc-a");
			});

			it("still leaves the pin when a failure memo pushed the head back", () => {
				const accounts = pool();
				const strategy = new SessionStrategy();
				reserveTheStrategysPick();
				recordFamilyWeeklyExhausted(
					"acc-b",
					"sonnet",
					Date.now() + HOUR,
					Date.now(),
				);

				const { follow } = route(strategy, accounts, {
					model: MODEL,
					served: "acc-b",
				});
				expect(follow).toBeNull();
			});

			it("still ignores token counts and synthetic probes", () => {
				const accounts = pool();
				const strategy = new SessionStrategy();
				reserveTheStrategysPick();

				expect(
					route(strategy, accounts, {
						model: MODEL,
						path: "/v1/messages/count_tokens",
					}).follow,
				).toBeNull();
				expect(
					route(strategy, accounts, {
						model: MODEL,
						isSyntheticProbeRequest: true,
					}).follow,
				).toBeNull();
			});

			it("still never follows to another provider", () => {
				const accounts = [
					makeAccount({ id: "acc-a", name: "a", priority: 0 }),
					makeAccount({
						id: "codex-1",
						name: "codex",
						provider: "codex",
						priority: 1,
						resolvedModel: "gpt-6-astra",
					}),
					makeAccount({ id: "acc-c", name: "c", priority: 2 }),
				];
				const strategy = new SessionStrategy();
				seedUsage("acc-a", 99, 10);
				seedUsage("acc-c", 20, 20);

				const { candidates, follow } = route(strategy, accounts, {
					model: MODEL,
				});
				expect(candidates[0].id).toBe("codex-1");
				expect(follow).toBeNull();
			});

			it("still does not follow while the pinned account is on a transient hold", () => {
				const accounts = pool();
				const strategy = new SessionStrategy();
				seedUsage("acc-b", 20, 20);
				seedUsage("acc-c", 20, 20);
				route(strategy, accounts, { model: MODEL }); // pins acc-a

				accounts[0].rate_limited_until = Date.now() + 60_000;
				seedUsage("acc-a", 99, 95);
				const held = route(strategy, accounts, { model: MODEL });
				expect(held.meta.routing?.decision).toBe("affinity_hold");
				expect(held.follow).toBeNull();
			});
		});
	});
});

describe("affinity after durable request exclusions", () => {
	it("keeps the compatible account sticky after rejecting a smaller context window", () => {
		const accounts = ["small", "large-a", "large-b"].map((id, i) =>
			makeAccount({
				id,
				name: id,
				provider: "codex",
				priority: i ? 1 : 0,
				resolvedModel: i ? "gpt-6-astra" : "gpt-5.3-codex-spark",
			}),
		);
		let preferred = "large-a";
		const strategy = new SessionStrategy();
		strategy.initialize({
			resetAccountSession() {},
			getAccountUtilization: (id) => (id === preferred ? 10 : 30),
		});
		for (const pref of ["large-a", "large-b"]) {
			preferred = pref;
			const meta = makeRequestMeta({
				affinityKey: "conversation",
				affinityScope: "claude_session",
			});
			const selected = strategy.select(accounts, meta);
			const gates = createAdmissionGates(
				{
					requestMeta: meta,
					gateTokenEstimate: 150_000,
					isSyntheticProbeRequest: false,
					config: makeConfig({ fiveHour: false, weekly: false }),
					strategy,
				},
				MODEL,
			);
			const candidates = gates.applyContextWindowGate(selected);
			gates.reconcileAffinity(candidates);
			expect(candidates[0].id).toBe("large-a");
			expect(meta.routing?.heldAccountId).toBe("large-a");
		}
	});
	it("rebinds affinity when the requested family is weekly-exhausted", () => {
		const accounts = [
			makeAccount({ id: "family-affinity-spent", priority: 0 }),
			makeAccount({ id: "family-affinity-ready", priority: 1 }),
		];
		seedFamilyOverpace(accounts[0].id, 100);
		try {
			const strategy = new SessionStrategy();
			const meta = makeRequestMeta({
				affinityKey: "family-conversation",
				affinityScope: "claude_session",
			});
			const selected = strategy.select(accounts, meta);
			expect(selected[0].id).toBe(accounts[0].id);
			const gates = createAdmissionGates(
				{
					requestMeta: meta,
					gateTokenEstimate: 1,
					isSyntheticProbeRequest: false,
					config: makeConfig({ fiveHour: false, weekly: false }),
					strategy,
				},
				"claude-fable-5",
			);
			const candidates = gates.applyFamilyWeeklyGate(selected);
			expect(candidates.map((account) => account.id)).toEqual([accounts[1].id]);
			gates.reconcileAffinity(candidates);
			const next = makeRequestMeta({
				affinityKey: "family-conversation",
				affinityScope: "claude_session",
			});
			expect(strategy.select(accounts, next)[0].id).toBe(accounts[1].id);
		} finally {
			usageCache.delete(accounts[0].id);
		}
	});

	it("rebinds only the exhausted model's pin when the family is weekly-exhausted", () => {
		const accounts = [
			makeAccount({ id: "family-affinity-spent", priority: 0 }),
			makeAccount({ id: "family-affinity-ready", priority: 1 }),
		];
		const turn = (model: string) =>
			makeRequestMeta({
				affinityKey: "family-conversation",
				affinityScope: "claude_session",
				affinityModel: model,
			});
		try {
			const strategy = new SessionStrategy();
			expect(strategy.select(accounts, turn(MODEL))[0].id).toBe(accounts[0].id);
			seedFamilyOverpace(accounts[0].id, 100);

			const meta = turn("claude-fable-5");
			const selected = strategy.select(accounts, meta);
			expect(selected[0].id).toBe(accounts[0].id);
			const gates = createAdmissionGates(
				{
					requestMeta: meta,
					gateTokenEstimate: 1,
					isSyntheticProbeRequest: false,
					config: makeConfig({ fiveHour: false, weekly: false }),
					strategy,
				},
				"claude-fable-5",
			);
			const candidates = gates.applyFamilyWeeklyGate(selected);
			expect(candidates.map((account) => account.id)).toEqual([accounts[1].id]);
			gates.reconcileAffinity(candidates);
			expect(meta.routing?.decision).toBe("affinity_reassigned");

			expect(strategy.select(accounts, turn("claude-fable-5"))[0].id).toBe(
				accounts[1].id,
			);
			const sonnet = turn(MODEL);
			expect(strategy.select(accounts, sonnet)[0].id).toBe(accounts[0].id);
			expect(sonnet.routing?.decision).toBe("affinity_hit");
		} finally {
			usageCache.delete(accounts[0].id);
		}
	});

	it("temporary exclusions do not overwrite the original affinity", () => {
		const accounts = [
			makeAccount({ id: "a", priority: 0 }),
			makeAccount({ id: "b", priority: 1 }),
		];
		const strategy = new SessionStrategy();
		const meta = makeRequestMeta({
			affinityKey: "conversation",
			affinityScope: "claude_session",
		});
		strategy.select(accounts, meta);
		const gates = createAdmissionGates(
			{
				requestMeta: meta,
				gateTokenEstimate: 1,
				isSyntheticProbeRequest: false,
				config: makeConfig({ fiveHour: false, weekly: false }),
				strategy,
			},
			MODEL,
		);
		gates.reconcileAffinity([accounts[1]]);
		const next = makeRequestMeta({
			affinityKey: "conversation",
			affinityScope: "claude_session",
		});
		expect(strategy.select(accounts, next)[0].id).toBe("a");
	});
});

describe("Astra subscription context admission", () => {
	it("admits the reported failing request for native and mapped Astra models", () => {
		const account = makeAccount({
			provider: "codex",
			resolvedModel: "gpt-6-astra",
		});
		for (const model of ["gpt-6-astra", "gpt-6-astra-2026-09-03", MODEL]) {
			const gates = makeGates({
				requestModel: model,
				gateTokenEstimate: 273_764,
			});
			expect(gates.applyContextWindowGate([account])).toEqual([account]);
		}
	});

	it("keeps a resolved target fixed across later fixture edits", () => {
		const account = makeAccount({
			provider: "codex",
			resolvedModel: "gpt-5.3-codex-spark",
		});
		const gates = makeGates({ gateTokenEstimate: 150_000 });
		expect(gates.applyContextWindowGate([account])).toEqual([]);
		gateTargets.set(account.id, "gpt-6-astra");
		expect(gates.applyContextWindowGate([account])).toEqual([]);
	});
});
