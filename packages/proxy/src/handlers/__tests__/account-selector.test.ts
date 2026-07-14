import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, ComboWithSlots, RequestMeta } from "@clankermux/types";
import {
	__resetColdRefreshState,
	ensureUsageFreshForSelection,
	getComboSlotInfo,
	selectAccountsForRequest,
	setComboSlotInfo,
} from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
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
		...overrides,
	};
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeCombo(slots: ComboWithSlots["slots"]): ComboWithSlots {
	return {
		id: "combo-1",
		name: "Test Combo",
		description: null,
		enabled: true,
		created_at: Date.now(),
		updated_at: Date.now(),
		slots,
	};
}

function makeCtx(
	opts: { accounts?: Account[]; activeCombo?: ComboWithSlots | null } = {},
): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => opts.activeCombo ?? null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

// ── setComboSlotInfo / getComboSlotInfo ───────────────────────────────────────

describe("setComboSlotInfo / getComboSlotInfo", () => {
	it("stores and retrieves combo slot info on a RequestMeta", () => {
		const meta = makeRequestMeta();
		const info = {
			comboName: "My Combo",
			slots: [{ accountId: "acc-1", modelOverride: "gpt-4" }],
		};
		setComboSlotInfo(meta, info);
		expect(getComboSlotInfo(meta)).toEqual(info);
	});

	it("returns null for a meta that was never set", () => {
		const meta = makeRequestMeta();
		expect(getComboSlotInfo(meta)).toBeNull();
	});

	it("is isolated per RequestMeta object (WeakMap semantics)", () => {
		const meta1 = makeRequestMeta();
		const meta2 = makeRequestMeta();
		setComboSlotInfo(meta1, {
			comboName: "Combo A",
			slots: [{ accountId: "a", modelOverride: "m" }],
		});
		expect(getComboSlotInfo(meta2)).toBeNull();
	});
});

// ── selectAccountsForRequest — forced account via header ──────────────────────

describe("selectAccountsForRequest — x-clankermux-account-id header", () => {
	it("returns exactly the forced account when the header matches", async () => {
		const acc1 = makeAccount({ id: "acc-1", name: "first" });
		const acc2 = makeAccount({ id: "acc-2", name: "second" });
		const ctx = makeCtx({ accounts: [acc1, acc2] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-clankermux-account-id": "acc-2" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-2");
	});

	it("still routes via the legacy x-better-ccflare-account-id header (dual-accept)", async () => {
		const acc1 = makeAccount({ id: "acc-1", name: "first" });
		const acc2 = makeAccount({ id: "acc-2", name: "second" });
		const ctx = makeCtx({ accounts: [acc1, acc2] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-2");
	});

	it("prefers the new header over the legacy one when both are present", async () => {
		const acc1 = makeAccount({ id: "acc-1", name: "first" });
		const acc2 = makeAccount({ id: "acc-2", name: "second" });
		const ctx = makeCtx({ accounts: [acc1, acc2] });
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-clankermux-account-id": "acc-1",
				"x-better-ccflare-account-id": "acc-2",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-1");
	});

	it("falls through to normal selection when forced account id is not found", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta({
			headers: new Headers({ "x-clankermux-account-id": "nonexistent" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Falls back to strategy.select result
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-1");
	});

	it("falls through to normal selection when forced account is paused", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			paused: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		// Strategy mock returns only the active account (simulates SessionStrategy filtering)
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-clankermux-account-id": "acc-paused" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Paused forced account is skipped; falls back to strategy.select which returns activeAcc
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-active");
	});

	it("falls through to normal selection when forced account is rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		// Strategy mock returns only the active account (simulates SessionStrategy filtering)
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-clankermux-account-id": "acc-rl" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Rate-limited forced account is skipped; falls back to strategy.select which returns activeAcc
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-active");
	});

	// ── synthetic/internal force-routes must NOT fall through to a sibling ──────

	it("internal force-route to a manual-paused account returns [] (no fallthrough)", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			paused: true,
			pause_reason: "manual",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({ "x-clankermux-account-id": "acc-paused" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Synthetic force-route must resolve to exactly the forced account or nothing —
		// never a sibling. Paused + internal => no candidates.
		expect(result).toEqual([]);
	});

	it("internal force-route to a non-existent/deleted account returns [] (no fallthrough)", async () => {
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({ "x-clankermux-account-id": "deleted-id" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toEqual([]);
	});

	it("internal force-route to an available account returns exactly that account", async () => {
		const targetAcc = makeAccount({ id: "acc-target", name: "target" });
		const otherAcc = makeAccount({ id: "acc-other", name: "other" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [otherAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [targetAcc, otherAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({ "x-clankermux-account-id": "acc-target" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-target");
	});

	it("internal bypass-session force-route to an overage-paused account STILL returns it (auto-refresh probe preserved)", async () => {
		const overageAcc = makeAccount({
			id: "acc-overage",
			name: "overage",
			paused: true,
			pause_reason: "overage",
			auto_pause_on_overage_enabled: true,
		});
		const otherAcc = makeAccount({ id: "acc-other", name: "other" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [otherAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overageAcc, otherAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({
				"x-clankermux-account-id": "acc-overage",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-overage");
	});

	it("internal bypass-session force-route to a rate-limited account STILL returns it (auto-refresh probe preserved)", async () => {
		const rlAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const otherAcc = makeAccount({ id: "acc-other", name: "other" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [otherAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rlAcc, otherAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({
				"x-clankermux-account-id": "acc-rl",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-rl");
	});

	it("internal force-route returns [] when the DB throws (fail closed)", async () => {
		// A transient DB error during the forced-account lookup must NOT let an
		// internal (synthetic) force-route fall through to a sibling account.
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => {
					throw new Error("synthetic-db-failure");
				}),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({ "x-clankermux-account-id": "acc-target" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toEqual([]);
	});

	it("NON-internal force-route falls through to normal selection when the DB throws (unchanged)", async () => {
		// For a hand-typed force-route header, a DB error still degrades to normal
		// selection (getAllAccounts is called again by selectByStrategy and succeeds
		// here via a separate mock).
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		let calls = 0;
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				// First call (forced lookup) throws; later calls succeed so the
				// fall-through to normal selection can resolve an account.
				getAllAccounts: mock(async () => {
					calls += 1;
					if (calls === 1) throw new Error("synthetic-db-failure");
					return [activeAcc];
				}),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			// no internal flag => hand-typed testing header
			headers: new Headers({ "x-clankermux-account-id": "acc-target" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-active");
	});

	it("NON-internal force-route to a paused account still falls through to normal selection (unchanged)", async () => {
		const pausedAcc = makeAccount({
			id: "acc-paused",
			name: "paused",
			paused: true,
			pause_reason: "manual",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [pausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			// no internal flag => hand-typed testing header
			headers: new Headers({ "x-clankermux-account-id": "acc-paused" }),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-active");
	});
});

// ── selectAccountsForRequest — combo routing ──────────────────────────────────

describe("selectAccountsForRequest — combo routing", () => {
	it("returns combo-ordered accounts when an active combo exists for the model family", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Both accounts should be returned in slot priority order
		expect(result.map((a) => a.id)).toEqual(["acc-1", "acc-2"]);
	});

	it("stores combo slot info on the RequestMeta when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-opus-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-opus-4-5");

		const slotInfo = getComboSlotInfo(meta);
		expect(slotInfo).not.toBeNull();
		expect(slotInfo?.comboName).toBe("Test Combo");
		expect(slotInfo?.slots[0]?.accountId).toBe("acc-1");
		expect(slotInfo?.slots[0]?.modelOverride).toBe("claude-opus-4-5");
	});

	it("sets meta.comboName when combo routing is active", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-haiku-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		await selectAccountsForRequest(meta, ctx, "claude-haiku-4-5");
		expect(meta.comboName).toBe("Test Combo");
	});

	it("skips disabled slots", async () => {
		const acc1 = makeAccount({ id: "acc-1" });
		const acc2 = makeAccount({ id: "acc-2" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: false, // disabled
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-2",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc1, acc2], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-2"]);
	});

	it("falls back to SessionStrategy when all combo slots are rate-limited", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-1",
			rate_limited_until: Date.now() + 3_600_000, // rate limited for 1h
		});
		const fallbackAcc = makeAccount({ id: "acc-fallback" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);

		const ctx = {
			strategy: {
				select: mock(() => [fallbackAcc]),
			},
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, fallbackAcc]),
				getActiveComboForFamily: mock(async () => combo),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;

		const meta = makeRequestMeta();
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Should fall back to strategy result (fallbackAcc)
		expect(result[0]?.id).toBe("acc-fallback");
	});

	it("does not leave combo metadata behind when all combo slots are unavailable", async () => {
		const rateLimitedAcc = makeAccount({
			id: "acc-1",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const fallbackAcc = makeAccount({ id: "acc-fallback" });
		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
		]);
		const ctx = {
			strategy: {
				select: mock(() => [fallbackAcc]),
			},
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, fallbackAcc]),
				getActiveComboForFamily: mock(async () => combo),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		expect(result[0]?.id).toBe("acc-fallback");
		expect(meta.comboName).toBeUndefined();
		expect(getComboSlotInfo(meta)).toBeNull();
	});

	it("falls back to SessionStrategy when no combo is active for the model family", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc], activeCombo: null });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// No combo — strategy.select is used
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("falls back to normal routing when no model is provided", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(meta, ctx);
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo lookup for unknown model families", async () => {
		const acc = makeAccount({ id: "acc-normal" });
		const ctx = makeCtx({ accounts: [acc] });
		const meta = makeRequestMeta();

		// A model that doesn't map to a known family
		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"gpt-4-turbo-unknown",
		);
		// getActiveComboForFamily should not be called for unknown families
		expect(
			ctx.dbOps.getActiveComboForFamily as unknown as Mock<
				typeof ctx.dbOps.getActiveComboForFamily
			>,
		).not.toHaveBeenCalled();
		expect(result[0]?.id).toBe("acc-normal");
	});

	it("skips combo slots that reference unknown accounts", async () => {
		const acc = makeAccount({ id: "acc-1" });
		const combo = makeCombo([
			{
				id: "slot-ghost",
				combo_id: "combo-1",
				account_id: "acc-ghost", // does not exist in accounts list
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-real",
				combo_id: "combo-1",
				account_id: "acc-1",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({ accounts: [acc], activeCombo: combo });
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		// Ghost slot is skipped; only acc-1 is returned
		expect(result.map((a) => a.id)).toEqual(["acc-1"]);
	});

	it("re-syncs candidatesCount after excluding official-Anthropic accounts later in the list", async () => {
		// Combo head is a Codex account; an official Anthropic account sits later.
		// With excludeOfficialAnthropic the Anthropic account is filtered out but
		// the head is unchanged — candidatesCount must still shrink from 2 to 1.
		const codexHead = makeAccount({ id: "acc-codex", provider: "codex" });
		const anthropicLater = makeAccount({
			id: "acc-anthropic",
			provider: "anthropic",
		});
		const combo = makeCombo([
			{
				id: "slot-codex",
				combo_id: "combo-1",
				account_id: "acc-codex",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-anthropic",
				combo_id: "combo-1",
				account_id: "acc-anthropic",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);
		const ctx = makeCtx({
			accounts: [codexHead, anthropicLater],
			activeCombo: combo,
		});
		const meta = makeRequestMeta({ excludeOfficialAnthropic: true });

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);

		// Official Anthropic account filtered out; Codex head remains.
		expect(result.map((a) => a.id)).toEqual(["acc-codex"]);
		expect(meta.routing?.selectedAccountId).toBe("acc-codex");
		expect(meta.routing?.candidatesCount).toBe(1);
	});
});

// ── selectAccountsForRequest — auto-refresh bypass for overage-paused accounts ─

describe("selectAccountsForRequest — auto-refresh bypass (overage-paused accounts)", () => {
	/**
	 * The auto-refresh scheduler intentionally refreshes accounts that are paused
	 * due to auto_pause_on_overage. It sends x-clankermux-bypass-session: true
	 * alongside x-clankermux-account-id. The selector must allow these through
	 * so the scheduler can hit the real endpoint and trigger auto-resume.
	 */
	it("allows overage-paused account when internal bypass-session header is present", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({
				"x-clankermux-account-id": "acc-overage",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Overage-paused account must be returned directly — bypass-session overrides the guard
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-overage");
	});

	it("does not honor bypass-session from external client traffic", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "overage",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-clankermux-account-id": "acc-overage",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-active");
	});

	it("still blocks overage-paused account without the bypass-session header", async () => {
		const overagePausedAcc = makeAccount({
			id: "acc-overage",
			name: "overage-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [overagePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({
				"x-clankermux-account-id": "acc-overage",
				// No bypass-session header — normal user traffic should still be blocked
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Without bypass header the account is unavailable; falls back to strategy
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-active");
	});

	it("blocks manually-paused overage-enabled account even with bypass-session header", async () => {
		// A manual pause must win even when auto_pause_on_overage_enabled is set:
		// the auto-resume guard would never un-pause it, so admitting it on a
		// bypass-session force-route just produces an endless probe loop. Mirrors
		// the scheduler eligibility query and the sendTranslatedClaudePrime resume guard.
		const manualPausedAcc = makeAccount({
			id: "acc-manual",
			name: "manual-paused",
			paused: true,
			auto_pause_on_overage_enabled: true,
			pause_reason: "manual",
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [manualPausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({
				"x-clankermux-account-id": "acc-manual",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Manual pause is not overage → not allowed through. Because this is an
		// internal force-route, it must NOT fall through to a sibling — it resolves
		// to the forced account or to nothing. Manual-paused + internal => [].
		expect(result).toEqual([]);
	});

	it("allows rate-limited (non-paused) account when bypass-session header is present", async () => {
		// The scheduler probes rate-limited accounts to detect when the window has reset.
		// Without this fix the account selector falls through to SessionStrategy and routes
		// to a *different* account, corrupting the intended account's rate_limit_reset row.
		const rateLimitedAcc = makeAccount({
			id: "acc-rl",
			name: "rate-limited",
			paused: false,
			rate_limited_until: Date.now() + 3_600_000,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [rateLimitedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({
				"x-clankermux-account-id": "acc-rl",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Rate-limited account must be returned directly — bypass-session overrides the guard
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("acc-rl");
	});

	it("blocks failure-paused account even with bypass-session header", async () => {
		// A failure-paused account: paused=true, auto_pause_on_overage_enabled=false
		const failurePausedAcc = makeAccount({
			id: "acc-broken",
			name: "failure-paused",
			paused: true,
			auto_pause_on_overage_enabled: false,
		});
		const activeAcc = makeAccount({ id: "acc-active", name: "active" });
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [activeAcc]) },
			dbOps: {
				getAllAccounts: mock(async () => [failurePausedAcc, activeAcc]),
				getActiveComboForFamily: mock(async () => null),
			},
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			internal: true,
			headers: new Headers({
				"x-clankermux-account-id": "acc-broken",
				"x-clankermux-bypass-session": "true",
			}),
		});

		const result = await selectAccountsForRequest(meta, ctx);
		// Failure-paused accounts must NOT be bypassed — the endpoint is broken.
		// And since this is an internal force-route, it must NOT fall through to a
		// sibling either: it resolves to the forced account or to nothing => [].
		expect(result).toEqual([]);
	});
});

// ── selectAccountsForRequest — paused account handling ───────────────────────

describe("selectAccountsForRequest — paused accounts in combo", () => {
	it("excludes paused accounts from combo slot results", async () => {
		const pausedAcc = makeAccount({ id: "acc-paused", paused: true });
		const activeAcc = makeAccount({ id: "acc-active" });

		const combo = makeCombo([
			{
				id: "slot-1",
				combo_id: "combo-1",
				account_id: "acc-paused",
				model: "claude-sonnet-4-5",
				priority: 0,
				enabled: true,
			},
			{
				id: "slot-2",
				combo_id: "combo-1",
				account_id: "acc-active",
				model: "claude-sonnet-4-5",
				priority: 1,
				enabled: true,
			},
		]);

		const ctx = makeCtx({
			accounts: [pausedAcc, activeAcc],
			activeCombo: combo,
		});
		const meta = makeRequestMeta();

		const result = await selectAccountsForRequest(
			meta,
			ctx,
			"claude-sonnet-4-5",
		);
		expect(result.map((a) => a.id)).toEqual(["acc-active"]);
	});
});

// ── ensureUsageFreshForSelection — cold-start Anthropic usage refresh ─────────

describe("ensureUsageFreshForSelection", () => {
	const POLL_INTERVAL_MS = 90_000;

	function makeUsageCtx(): ProxyContext {
		return {
			config: {
				getUsagePollIntervalMs: () => POLL_INTERVAL_MS,
			},
		} as unknown as ProxyContext;
	}

	// Capacity datum with a future reset window — counts as "fresh/known".
	function freshUsageData() {
		return {
			five_hour: {
				utilization: 10,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
		};
	}

	let getAgeSpy: ReturnType<typeof spyOn>;
	let getSpy: ReturnType<typeof spyOn>;
	let getRlSpy: ReturnType<typeof spyOn>;
	let refreshSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		__resetColdRefreshState();
		// Default: everything unknown, not rate-limited, refresh resolves true.
		getAgeSpy = spyOn(usageCache, "getAge").mockReturnValue(null);
		getSpy = spyOn(usageCache, "get").mockReturnValue(null);
		getRlSpy = spyOn(usageCache, "getRateLimitedUntil").mockReturnValue(null);
		refreshSpy = spyOn(usageCache, "refreshNow").mockResolvedValue(true);
	});

	afterEach(() => {
		getAgeSpy.mockRestore();
		getSpy.mockRestore();
		getRlSpy.mockRestore();
		refreshSpy.mockRestore();
	});

	it("refreshes an unknown Anthropic account", async () => {
		const acc = makeAccount({ id: "acc-anthropic", provider: "anthropic" });
		const ctx = makeUsageCtx();

		await ensureUsageFreshForSelection([acc], ctx, Date.now());

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledWith("acc-anthropic");
	});

	it("skips non-Anthropic providers (codex, zai) even when usage is unknown", async () => {
		const codex = makeAccount({ id: "acc-codex", provider: "codex" });
		const zai = makeAccount({ id: "acc-zai", provider: "zai" });
		const ctx = makeUsageCtx();

		await ensureUsageFreshForSelection([codex, zai], ctx, Date.now());

		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("skips an Anthropic account that already has fresh capacity", async () => {
		const acc = makeAccount({ id: "acc-fresh", provider: "anthropic" });
		const ctx = makeUsageCtx();
		// Fresh age (well under maxAge) + valid windowed data with a future reset.
		getAgeSpy.mockReturnValue(1_000);
		getSpy.mockReturnValue(freshUsageData());

		await ensureUsageFreshForSelection([acc], ctx, Date.now());

		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("does not refresh the same account again within the cooldown window", async () => {
		const acc = makeAccount({ id: "acc-cool", provider: "anthropic" });
		const ctx = makeUsageCtx();
		const now = Date.now();

		await ensureUsageFreshForSelection([acc], ctx, now);
		expect(refreshSpy).toHaveBeenCalledTimes(1);

		// Second call 5s later (< COLD_REFRESH_COOLDOWN_MS=30s) → no new refresh.
		await ensureUsageFreshForSelection([acc], ctx, now + 5_000);
		expect(refreshSpy).toHaveBeenCalledTimes(1);
	});

	it("refreshes again once the cooldown window has elapsed", async () => {
		const acc = makeAccount({ id: "acc-cool2", provider: "anthropic" });
		const ctx = makeUsageCtx();
		const now = Date.now();

		await ensureUsageFreshForSelection([acc], ctx, now);
		expect(refreshSpy).toHaveBeenCalledTimes(1);

		// 31s later (> 30s cooldown) → refreshes again.
		await ensureUsageFreshForSelection([acc], ctx, now + 31_000);
		expect(refreshSpy).toHaveBeenCalledTimes(2);
	});

	it("skips an account whose usage API is rate-limited (getRateLimitedUntil in the future)", async () => {
		const acc = makeAccount({ id: "acc-rl-usage", provider: "anthropic" });
		const ctx = makeUsageCtx();
		const now = Date.now();
		getRlSpy.mockReturnValue(now + 60_000);

		await ensureUsageFreshForSelection([acc], ctx, now);

		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("awaits the refresh when the only available top-tier account is unknown", async () => {
		const acc = makeAccount({
			id: "acc-solo",
			provider: "anthropic",
			priority: 0,
		});
		const ctx = makeUsageCtx();

		let resolved = false;
		refreshSpy.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					setTimeout(() => {
						resolved = true;
						resolve(true);
					}, 10);
				}),
		);

		await ensureUsageFreshForSelection([acc], ctx, Date.now());

		// The race resolves via the (fast) fetch, not the 300ms timeout, so by the
		// time the call returns the refresh has completed.
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(resolved).toBe(true);
	});

	it("refreshes a stale lower-priority account in the background when a higher-priority account is already fresh", async () => {
		const fresh = makeAccount({
			id: "acc-top-fresh",
			provider: "anthropic",
			priority: 0,
		});
		const staleLow = makeAccount({
			id: "acc-low-stale",
			provider: "anthropic",
			priority: 1,
		});
		const ctx = makeUsageCtx();

		// Top-tier account (priority 0) is fresh; lower-priority is unknown.
		getAgeSpy.mockImplementation((id: string) =>
			id === "acc-top-fresh" ? 1_000 : null,
		);
		getSpy.mockImplementation((id: string) =>
			id === "acc-top-fresh" ? freshUsageData() : null,
		);

		// Background refresh must NOT be awaited: make it never resolve and assert
		// the call still returns promptly.
		let settled = false;
		refreshSpy.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					setTimeout(() => {
						settled = true;
						resolve(true);
					}, 5_000);
				}),
		);

		await ensureUsageFreshForSelection([fresh, staleLow], ctx, Date.now());

		// refreshNow was kicked off for the stale lower-priority account...
		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledWith("acc-low-stale");
		// ...but the function returned without waiting for it (top tier was fresh).
		expect(settled).toBe(false);
	});

	it("ignores unavailable Anthropic accounts (paused / rate_limited_until in the future)", async () => {
		const paused = makeAccount({
			id: "acc-paused",
			provider: "anthropic",
			paused: true,
		});
		const rateLimited = makeAccount({
			id: "acc-rl-account",
			provider: "anthropic",
			rate_limited_until: Date.now() + 3_600_000,
		});
		const ctx = makeUsageCtx();

		await ensureUsageFreshForSelection([paused, rateLimited], ctx, Date.now());

		expect(refreshSpy).not.toHaveBeenCalled();
	});
});
