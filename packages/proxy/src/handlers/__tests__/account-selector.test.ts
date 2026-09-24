import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { SessionStrategy } from "@clankermux/load-balancer";
import { buildUsageView, usageCache } from "@clankermux/providers";
import { makeAccount as canonicalAccount } from "@clankermux/test-support";
import type { Account, RequestMeta } from "@clankermux/types";
import {
	__resetColdRefreshState,
	ensureUsageFreshForSelection,
	selectAccountsForRequest,
} from "../../__tests__/fixtures/routing-harness";
import type { ProxyContext } from "../proxy-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAccount(overrides: Partial<Account> = {}): Account {
	return canonicalAccount({
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		...overrides,
	});
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

function makeCtx(opts: { accounts?: Account[] } = {}): ProxyContext {
	const accounts = opts.accounts ?? [makeAccount()];
	return {
		strategy: {
			select: mock((_all: Account[], _meta: RequestMeta) => accounts),
		},
		dbOps: {
			getAllAccounts: mock(async () => accounts),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
	} as unknown as ProxyContext;
}

// ── setComboSlotInfo / getComboSlotInfo ───────────────────────────────────────

// ── selectAccountsForRequest — forced account via header ──────────────────────

describe("forced destination selection", () => {
	it.each([
		false,
		true,
	])("rejects a missing destination, internal=%s", async (internal) => {
		const ctx = makeCtx();
		const meta = makeRequestMeta({
			internal,
			headers: new Headers({ "x-clankermux-account-id": "missing" }),
		});
		await expect(selectAccountsForRequest(meta, ctx)).rejects.toThrow();
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
	it.each([
		false,
		true,
	])("fails closed on a database failure, internal=%s", async (internal) => {
		const ctx = makeCtx();
		ctx.dbOps.getAllAccounts = mock(async () => {
			throw new Error("database unavailable");
		});
		const meta = makeRequestMeta({
			internal,
			headers: new Headers({ "x-clankermux-account-id": "acc-1" }),
		});
		await expect(selectAccountsForRequest(meta, ctx)).rejects.toThrow(
			"database unavailable",
		);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
	});
	it("force-routes to the account named by x-clankermux-account-id", async () => {
		const ctx = makeCtx({
			accounts: [makeAccount(), makeAccount({ id: "acc-2" })],
		});
		const meta = makeRequestMeta({
			headers: new Headers({ "x-clankermux-account-id": "acc-2" }),
		});
		expect(
			(await selectAccountsForRequest(meta, ctx)).map((a) => a.id),
		).toEqual(["acc-2"]);
	});
	// The retired x-better-ccflare-account-id spelling appears here on purpose:
	// this is the one place in the tree that still names it, pinning that it no
	// longer force-routes anything.
	it("ignores the retired x-better-ccflare-account-id header", async () => {
		const accounts = [makeAccount(), makeAccount({ id: "acc-2" })];
		const ctx: ProxyContext = {
			strategy: { select: mock(() => [accounts[0]]) },
			dbOps: { getAllAccounts: mock(async () => accounts) },
			refreshInFlight: new Map(),
			asyncWriter: { enqueue: mock(() => {}) },
		} as unknown as ProxyContext;
		const meta = makeRequestMeta({
			headers: new Headers({ "x-better-ccflare-account-id": "acc-2" }),
		});

		// The ordinary pooled pick, not the account the retired header names.
		expect(
			(await selectAccountsForRequest(meta, ctx)).map((a) => a.id),
		).toEqual(["acc-1"]);
		expect(ctx.strategy.select).toHaveBeenCalled();
	});
});

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

		expect(result).toEqual([]);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
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
		// The unavailable singleton cannot fall through to another destination.
		expect(result).toEqual([]);
		expect(ctx.strategy.select).not.toHaveBeenCalled();
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

	/** A routing view over a poll reading written 1s ago. */
	function freshView() {
		const writtenAtMs = Date.now() - 1_000;
		return buildUsageView(
			{
				data: freshUsageData() as never,
				writtenAtMs,
				observedAtMs: writtenAtMs,
			},
			null,
			Date.now(),
		);
	}

	let peekViewSpy: ReturnType<typeof spyOn>;
	let getRlSpy: ReturnType<typeof spyOn>;
	let refreshSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		__resetColdRefreshState();
		// Default: everything unknown, not rate-limited, refresh resolves true.
		peekViewSpy = spyOn(usageCache, "peekUsageView").mockReturnValue(null);
		getRlSpy = spyOn(usageCache, "getRateLimitedUntil").mockReturnValue(null);
		refreshSpy = spyOn(usageCache, "refreshNow").mockResolvedValue(true);
	});

	afterEach(() => {
		peekViewSpy.mockRestore();
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
		peekViewSpy.mockReturnValue(freshView());

		await ensureUsageFreshForSelection([acc], ctx, Date.now());

		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("skips an Anthropic account whose header readings are fresh though its poll is not", async () => {
		peekViewSpy.mockRestore();
		const ctx = makeUsageCtx();
		const HOUR = 3_600_000;
		const fiveReset = Math.floor((Date.now() + 2 * HOUR) / 1000) * 1000;
		const weekReset = Math.floor((Date.now() + 90 * HOUR) / 1000) * 1000;
		const seed = (id: string) => {
			usageCache.startPolling(
				id,
				async () => "token",
				"anthropic",
				POLL_INTERVAL_MS,
				null,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ initialDelayMs: 10 * HOUR },
			);
			usageCache.setWithAgeForTests(
				id,
				{
					five_hour: {
						utilization: 10,
						resets_at: new Date(fiveReset).toISOString(),
					},
					seven_day: {
						utilization: 20,
						resets_at: new Date(weekReset).toISOString(),
					},
				},
				400_000,
			);
		};
		const headerFed = makeAccount({ id: "acc-hdr-fed", provider: "anthropic" });
		const pollOnly = makeAccount({ id: "acc-hdr-none", provider: "anthropic" });
		seed(headerFed.id);
		seed(pollOnly.id);
		try {
			usageCache.recordUsageHeaders(
				headerFed.id,
				usageCache.usageHeaderEpoch(headerFed.id),
				[
					{
						claim: "5h",
						status: "allowed",
						utilization: 0.1,
						resetMs: fiveReset,
						surpassedThreshold: null,
					},
					{
						claim: "7d",
						status: "allowed",
						utilization: 0.2,
						resetMs: weekReset,
						surpassedThreshold: null,
					},
				],
				Date.now(),
			);

			await ensureUsageFreshForSelection(
				[headerFed, pollOnly],
				ctx,
				Date.now(),
			);

			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(refreshSpy).toHaveBeenCalledWith(pollOnly.id);
		} finally {
			usageCache.stopPolling(headerFed.id);
			usageCache.stopPolling(pollOnly.id);
		}
	});

	it("skips an idle account whose poll postdates its last use, refreshes one used since", async () => {
		peekViewSpy.mockRestore();
		const ctx = makeUsageCtx();
		const HOUR = 3_600_000;
		const reading = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: {
				utilization: 20,
				resets_at: new Date(Date.now() + 90 * HOUR).toISOString(),
			},
		};
		const seed = (id: string) => {
			usageCache.startPolling(
				id,
				async () => "token",
				"anthropic",
				POLL_INTERVAL_MS,
				null,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{ demandAware: true, initialDelayMs: 10 * HOUR },
			);
		};
		const idle = makeAccount({ id: "acc-trust-idle", provider: "anthropic" });
		const used = makeAccount({ id: "acc-trust-used", provider: "anthropic" });
		seed(idle.id);
		seed(used.id);
		try {
			usageCache.noteActivity(idle.id, Date.now() - 60 * 60_000);
			usageCache.setWithAgeForTests(idle.id, reading, 5 * 60_000);
			usageCache.setWithAgeForTests(used.id, reading, 5 * 60_000);
			usageCache.noteActivity(used.id, Date.now() - 60_000);

			await ensureUsageFreshForSelection([idle, used], ctx, Date.now());

			expect(refreshSpy).toHaveBeenCalledTimes(1);
			expect(refreshSpy).toHaveBeenCalledWith(used.id);
		} finally {
			usageCache.stopPolling(idle.id);
			usageCache.stopPolling(used.id);
		}
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
		peekViewSpy.mockImplementation((id: string) =>
			id === "acc-top-fresh" ? freshView() : null,
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

describe("provider pins preserve real strategy affinity", () => {
	it("keeps the served account sticky when a disallowed provider ranks first", async () => {
		const accounts = [
			makeAccount({ id: "codex", provider: "codex", priority: 0 }),
			makeAccount({ id: "claude-a", priority: 1 }),
			makeAccount({ id: "claude-b", priority: 1 }),
		];
		let preferred = "claude-a";
		const strategy = new SessionStrategy();
		strategy.initialize({
			resetAccountSession: () => {},
			getAccountUtilization: (id) => (id === preferred ? 10 : 30),
		});
		const ctx = makeCtx({ accounts });
		ctx.strategy = strategy;
		const meta = () =>
			makeRequestMeta({
				affinityKey: "conversation",
				affinityScope: "claude_session",
				pin: { accountId: null, providers: ["anthropic"] },
			});
		const first = meta();
		expect((await selectAccountsForRequest(first, ctx))[0].id).toBe("claude-a");
		preferred = "claude-b";
		const second = meta();
		expect((await selectAccountsForRequest(second, ctx))[0].id).toBe(
			"claude-a",
		);
		expect(second.routing?.decision).toBe("affinity_hit");
		expect(second.routing?.heldAccountId).toBe("claude-a");
		expect(second.routing?.previousAccountId).toBe("claude-a");
		// Editing the key's provider pin invalidates its former affinity.
		const changed = makeRequestMeta({
			...meta(),
			pin: { accountId: null, providers: ["codex"] },
		});
		expect((await selectAccountsForRequest(changed, ctx))[0].id).toBe("codex");
		expect(changed.routing?.decision).toBe("affinity_reassigned");
	});
});
