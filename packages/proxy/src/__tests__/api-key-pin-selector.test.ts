import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@clankermux/types";
import type { ProxyContext } from "../handlers";

mock.module("../inline-worker", () => ({
	EMBEDDED_WORKER_CODE: "",
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
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
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

/**
 * Minimal ProxyContext for exercising selectAccountsForRequest directly. The
 * strategy returns all non-paused / non-rate-limited accounts in their given
 * order (so the class-pin filter operates on a deterministic ordered list).
 */
function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			// Mirror the real SessionStrategy: filter to available accounts AND set
			// meta.routing (the strategy owns routing meta in production, so the
			// class-pin narrowing has a routing object to mutate).
			select: (accs: Account[], meta: RequestMeta) => {
				const now = Date.now();
				const ordered = accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until < now),
				);
				meta.routing = {
					strategy: "session",
					decision: "primary",
					selectedAccountId: ordered[0]?.id ?? null,
					candidatesCount: ordered.length,
					affinityScope: null,
					affinityKey: null,
					previousAccountId: null,
					failoverReason: null,
				};
				return ordered;
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) => accounts.find((a) => a.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		config: {
			getUsagePollIntervalMs: () => 60_000,
		} as never,
	} as never;
}

function makeMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		...overrides,
	};
}

async function select(meta: RequestMeta, ctx: ProxyContext, model?: string) {
	const { selectAccountsForRequest } = await import(
		"../handlers/account-selector"
	);
	return selectAccountsForRequest(meta, ctx, model);
}

describe("API-key pin: account selection", () => {
	beforeEach(() => {
		// Each test builds its own context; nothing global to reset here.
	});

	// --- Specific-account pin --------------------------------------------------

	it("specific-account pin, account available → returns just that account", async () => {
		const target = makeAccount({ id: "pin-target", name: "Pin-Target" });
		const other = makeAccount({ id: "other", name: "Other" });
		const ctx = makeContext([target, other]);
		const meta = makeMeta({
			pin: { accountId: "pin-target", providers: null },
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["pin-target"]);
		expect(meta.pinFailure).toBeFalsy();
		expect(meta.routing?.decision).toBe("pinned_account");
		expect(meta.routing?.selectedAccountId).toBe("pin-target");
		expect(meta.routing?.candidatesCount).toBe(1);
	});

	it("specific-account pin, account unavailable (paused) → strict-fail pinned_account_unavailable", async () => {
		const target = makeAccount({
			id: "pin-target",
			name: "Pin-Target",
			paused: true,
		});
		const ctx = makeContext([target]);
		const meta = makeMeta({
			pin: { accountId: "pin-target", providers: null },
		});

		const result = await select(meta, ctx);

		expect(result).toEqual([]);
		expect(meta.pinFailure?.code).toBe("pinned_account_unavailable");
		expect(meta.pinFailure?.message).toContain("pin-target");
		expect(meta.routing?.decision).toBe("pinned_rejected");
	});

	it("specific-account pin, account missing → strict-fail pinned_account_missing", async () => {
		const other = makeAccount({ id: "other", name: "Other" });
		const ctx = makeContext([other]);
		const meta = makeMeta({ pin: { accountId: "ghost", providers: null } });

		const result = await select(meta, ctx);

		expect(result).toEqual([]);
		expect(meta.pinFailure?.code).toBe("pinned_account_missing");
		expect(meta.pinFailure?.message).toContain("ghost");
		expect(meta.routing?.decision).toBe("pinned_rejected");
	});

	// --- Class (provider) pin --------------------------------------------------

	it("class pin, matching provider available → returns filtered accounts", async () => {
		const a1 = makeAccount({ id: "a1", name: "A1", provider: "anthropic" });
		const a2 = makeAccount({ id: "a2", name: "A2", provider: "anthropic" });
		const ctx = makeContext([a1, a2]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
		expect(meta.pinFailure).toBeFalsy();
		expect(meta.routing?.selectedAccountId).toBe("a1");
		expect(meta.routing?.candidatesCount).toBe(2);
	});

	it("class pin, partial match → returns only the allowed-provider accounts", async () => {
		const anthropic = makeAccount({
			id: "a1",
			name: "A1",
			provider: "anthropic",
		});
		const codex = makeAccount({ id: "c1", name: "C1", provider: "codex" });
		const ctx = makeContext([anthropic, codex]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a1"]);
		expect(meta.pinFailure).toBeFalsy();
		expect(meta.routing?.selectedAccountId).toBe("a1");
		expect(meta.routing?.candidatesCount).toBe(1);
	});

	it("class pin, no allowed provider available → strict-fail pinned_no_available_account", async () => {
		// Only a codex account exists; pin allows anthropic only.
		const codex = makeAccount({ id: "c1", name: "C1", provider: "codex" });
		const ctx = makeContext([codex]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
		});

		const result = await select(meta, ctx);

		expect(result).toEqual([]);
		expect(meta.pinFailure?.code).toBe("pinned_no_available_account");
		expect(meta.pinFailure?.message).toContain("anthropic");
		expect(meta.routing?.decision).toBe("pinned_rejected");
	});

	// --- Header narrowing within pin ------------------------------------------

	it("header narrows within pin (allowed + available) → returns the header target", async () => {
		const a1 = makeAccount({ id: "a1", name: "A1", provider: "anthropic" });
		const a2 = makeAccount({ id: "a2", name: "A2", provider: "anthropic" });
		const ctx = makeContext([a1, a2]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
			headers: new Headers({ "x-clankermux-account-id": "a2" }),
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a2"]);
		expect(meta.pinFailure).toBeFalsy();
		expect(meta.routing?.decision).toBe("pinned_header_narrowed");
		expect(meta.routing?.selectedAccountId).toBe("a2");
		expect(meta.routing?.candidatesCount).toBe(1);
	});

	it("header narrows within pin via legacy header name", async () => {
		const a1 = makeAccount({ id: "a1", name: "A1", provider: "anthropic" });
		const a2 = makeAccount({ id: "a2", name: "A2", provider: "anthropic" });
		const ctx = makeContext([a1, a2]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
			headers: new Headers({ "x-better-ccflare-account-id": "a2" }),
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a2"]);
		expect(meta.routing?.decision).toBe("pinned_header_narrowed");
	});

	it("header disallowed by pin → strict-fail pinned_header_rejected", async () => {
		const anthropic = makeAccount({
			id: "a1",
			name: "A1",
			provider: "anthropic",
		});
		const codex = makeAccount({ id: "c1", name: "C1", provider: "codex" });
		const ctx = makeContext([anthropic, codex]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
			// Header targets the codex account, which the pin disallows.
			headers: new Headers({ "x-clankermux-account-id": "c1" }),
		});

		const result = await select(meta, ctx);

		expect(result).toEqual([]);
		expect(meta.pinFailure?.code).toBe("pinned_header_rejected");
		expect(meta.routing?.decision).toBe("pinned_rejected");
	});

	it("header within pin but the target account is unavailable → strict-fail pinned_header_rejected", async () => {
		const a1 = makeAccount({ id: "a1", name: "A1", provider: "anthropic" });
		const a2 = makeAccount({
			id: "a2",
			name: "A2",
			provider: "anthropic",
			paused: true,
		});
		const ctx = makeContext([a1, a2]);
		const meta = makeMeta({
			pin: { accountId: null, providers: ["anthropic"] },
			headers: new Headers({ "x-clankermux-account-id": "a2" }),
		});

		const result = await select(meta, ctx);

		expect(result).toEqual([]);
		expect(meta.pinFailure?.code).toBe("pinned_header_rejected");
	});

	// --- No-pin path is unchanged ----------------------------------------------

	it("no pin: header force still honored (legacy behavior unchanged)", async () => {
		const a1 = makeAccount({ id: "a1", name: "A1" });
		const a2 = makeAccount({ id: "a2", name: "A2" });
		const ctx = makeContext([a1, a2]);
		const meta = makeMeta({
			headers: new Headers({ "x-clankermux-account-id": "a2" }),
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a2"]);
		expect(meta.routing?.decision).toBe("forced_account");
		expect(meta.pinFailure).toBeFalsy();
	});

	it("no pin: normal strategy selection still returns the ordered pool", async () => {
		const a1 = makeAccount({ id: "a1", name: "A1" });
		const a2 = makeAccount({ id: "a2", name: "A2" });
		const ctx = makeContext([a1, a2]);
		const meta = makeMeta();

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
		expect(meta.pinFailure).toBeFalsy();
	});

	it("internal request ignores the pin (carries none in practice; explicit guard via empty providers)", async () => {
		// In production internal probes never carry a pin. Guard the invariant: a
		// pin with no accountId and an empty providers list is inactive, so normal
		// selection runs.
		const a1 = makeAccount({ id: "a1", name: "A1" });
		const ctx = makeContext([a1]);
		const meta = makeMeta({
			internal: true,
			pin: { accountId: null, providers: [] },
		});

		const result = await select(meta, ctx);

		expect(result.map((a) => a.id)).toEqual(["a1"]);
		expect(meta.pinFailure).toBeFalsy();
	});
});

describe("createPinnedTargetUnavailableResponse", () => {
	it("returns a 503 with the standard error envelope and the failure code/message", async () => {
		const { createPinnedTargetUnavailableResponse } = await import(
			"../handlers/proxy-operations"
		);
		const response = createPinnedTargetUnavailableResponse({
			code: "pinned_account_unavailable",
			message: "Pinned account (acc-9) is currently unavailable.",
		});

		expect(response.status).toBe(503);
		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("pinned_account_unavailable");
		expect(body.error.message).toBe(
			"Pinned account (acc-9) is currently unavailable.",
		);
	});
});

describe("Codex-CLI floor: excludeOfficialAnthropic", () => {
	it("drops official Claude accounts (anthropic + claude-console-api), keeps others", async () => {
		const oauth = makeAccount({ id: "oauth", provider: "anthropic" });
		const console_ = makeAccount({ id: "cc", provider: "claude-console-api" });
		const codex = makeAccount({ id: "c1", provider: "codex" });
		const ollama = makeAccount({ id: "o1", provider: "ollama" });
		const ctx = makeContext([oauth, console_, codex, ollama]);

		const result = await select(
			makeMeta({ excludeOfficialAnthropic: true }),
			ctx,
		);

		expect(result.map((a) => a.id)).toEqual(["c1", "o1"]);
	});

	it("all-Claude pool → strict-fail with anthropic_excluded_no_account", async () => {
		const oauth = makeAccount({ id: "oauth", provider: "anthropic" });
		const console_ = makeAccount({ id: "cc", provider: "claude-console-api" });
		const ctx = makeContext([oauth, console_]);
		const meta = makeMeta({ excludeOfficialAnthropic: true });

		const result = await select(meta, ctx);

		expect(result).toEqual([]);
		expect(meta.pinFailure?.code).toBe("anthropic_excluded_no_account");
	});

	it("no Claude accounts in pool → returns the selection unchanged", async () => {
		const codex = makeAccount({ id: "c1", provider: "codex" });
		const ollama = makeAccount({ id: "o1", provider: "ollama" });
		const ctx = makeContext([codex, ollama]);

		const result = await select(
			makeMeta({ excludeOfficialAnthropic: true }),
			ctx,
		);

		expect(result.map((a) => a.id)).toEqual(["c1", "o1"]);
	});

	it("composes with a codex class pin (floor + pin both hold)", async () => {
		const oauth = makeAccount({ id: "oauth", provider: "anthropic" });
		const codex = makeAccount({ id: "c1", provider: "codex" });
		const ctx = makeContext([oauth, codex]);

		const result = await select(
			makeMeta({
				excludeOfficialAnthropic: true,
				pin: { accountId: null, providers: ["codex"] },
			}),
			ctx,
		);

		expect(result.map((a) => a.id)).toEqual(["c1"]);
	});
});
