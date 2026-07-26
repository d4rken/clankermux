import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { Logger, LogLevel } from "@clankermux/logger";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	clearAnthropicBurstThrottle,
	markAnthropicBurstThrottle,
	resetHoldSlots,
} from "../handlers/burst-cooldown";
import { resetOverloadHoldSlots } from "../overload-hold";
import {
	applyProviderOverloadCooldown,
	clearProviderOverloadCooldown,
} from "../provider-overload-cooldown";

// Deterministic burst-hold timing, mirroring burst-retry-hold-integration.test.ts:
// drive the hold's injectable clock well past the held account's 60s no-reset
// cooldown so a re-probe fires immediately, zero the jitter, cap the budget.
const HOLD_TIMING_OVERRIDE = {
	now: () => Date.now() + 10 * 60 * 1000,
	jitterMs: 0,
	maxHoldMs: 2_000,
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function callHandleProxy(req: Request, url: URL, ctx: ProxyContext) {
	const { handleProxy } = await import("../proxy");
	return handleProxy(
		req,
		url,
		ctx,
		undefined,
		undefined,
		false,
		HOLD_TIMING_OVERRIDE,
	);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: Date.now() + HOUR,
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
	};
}

/**
 * Stateful stub of SessionStrategy's cache-affinity behavior: the FIRST select
 * pins the leading available account, every later select returns that pinned
 * account FIRST with decision `affinity_hit` and `heldAccountId` set — exactly
 * the shape the real strategy produces, and the shape whose ordering the
 * soft-demotion reorder must be able to override.
 *
 * Deliberately stateful so a test can drive TWO sequential requests through it
 * and assert the real upstream attempt order on the pinned (second) one.
 */
function makeAffinityStrategy() {
	let pinnedId: string | null = null;
	return {
		select: (accs: Account[], meta: RequestMeta) => {
			const now = Date.now();
			const available = accs.filter(
				(acc) =>
					!acc.paused &&
					(!acc.rate_limited_until || acc.rate_limited_until <= now),
			);
			if (pinnedId === null) pinnedId = available[0]?.id ?? null;
			const pinned = available.find((a) => a.id === pinnedId);
			const ordered = pinned
				? [pinned, ...available.filter((a) => a.id !== pinned.id)]
				: available;
			meta.routing = {
				strategy: "session",
				decision: "affinity_hit",
				affinityScope: "project",
				affinityKey: "k",
				selectedAccountId: ordered[0]?.id ?? null,
				previousAccountId: null,
				candidatesCount: ordered.length,
				failoverReason: null,
				heldAccountId: pinnedId,
			};
			return ordered;
		},
	} as never;
}

/**
 * Plain in-order strategy with NO affinity pin (`heldAccountId: null`), so the
 * burst-retry preflight branch is skipped entirely and the request reaches the
 * ordinary failover loop — where the late provider-overload check lives.
 */
function makeOrderedStrategy() {
	return {
		select: (accs: Account[], meta: RequestMeta) => {
			const now = Date.now();
			const available = accs.filter(
				(acc) =>
					!acc.paused &&
					(!acc.rate_limited_until || acc.rate_limited_until <= now),
			);
			meta.routing = {
				strategy: "session",
				decision: "affinity_miss",
				affinityScope: "project",
				affinityKey: "k",
				selectedAccountId: available[0]?.id ?? null,
				previousAccountId: null,
				candidatesCount: available.length,
				failoverReason: null,
				heldAccountId: null,
			};
			return available;
		},
	} as never;
}

function makeContext(
	accounts: Account[],
	strategy = makeAffinityStrategy(),
): ProxyContext {
	const byId = new Map(accounts.map((a) => [a.id, a]));
	return {
		strategy,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) => byId.get(id) ?? null),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(async () => 1),
			markAccountRateLimitedDeadlineOnly: mock(async () => {}),
			saveRequest: mock(async () => {}),
			updateAccountUsage: mock(async () => {}),
			updateAccountRateLimitMeta: mock(async () => {}),
			resetConsecutiveRateLimits: mock(async () => {}),
			getAdapter: mock(() => ({
				run: mock(async () => {}),
				get: mock(async () => null),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getCacheWarmingEnabled: () => false,
			getCacheWarmingMinTokens: () => 100_000,
			getStorePayloads: () => false,
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		requestRecorder: {
			begin: mock(() => {}),
			captureResponseChunk: mock(() => {}),
			finishTransport: mock(() => {}),
			attachUsageSummary: mock(() => {}),
			markUsageUnavailable: mock(() => {}),
			recordSynthetic: mock(() => {}),
			sweep: mock(() => {}),
			dispose: mock(() => {}),
		} as never,
	};
}

/**
 * Seed fresh usage. `fiveHour`/`weekly` are utilization percentages; the weekly
 * window resets `weeklyResetInMs` from now (the reserve's release horizon reads
 * the BINDING weekly reset).
 */
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

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	});
}

function isProxyCall(input: RequestInfo | URL): boolean {
	const url = input instanceof Request ? input.url : String(input);
	return url.includes("api.anthropic.com") || url.includes("/v1/messages");
}

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "claude-sonnet-4-5",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

/**
 * Install a fetch mock that records the ACCESS TOKEN of every upstream attempt,
 * in order, and answers 200. Asserting on this array is what makes these tests
 * about the real attempt order rather than an array index.
 */
function recordAttempts(originalFetch: typeof globalThis.fetch): string[] {
	const attempts: string[] = [];
	globalThis.fetch = mock(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (!isProxyCall(input)) return originalFetch(input as never, init);
			const headers =
				input instanceof Request ? input.headers : new Headers(init?.headers);
			// API-key providers (e.g. anthropic-compatible) authenticate with
			// `x-api-key` instead of a bearer token — record whichever is present so
			// the attempt array stays a faithful record for mixed-provider pools.
			const auth =
				headers.get("authorization") ?? headers.get("x-api-key") ?? "";
			attempts.push(auth.replace(/^Bearer\s+/i, ""));
			return ok200();
		},
	);
	return attempts;
}

/**
 * Capture the DEBUG lines the proxy emits during one request.
 *
 * `spyOn` on the Logger prototype (never `mock.module`, which leaks across this
 * repo's whole suite): `getLevel` is forced to DEBUG so the proxy's
 * DEBUG-guarded diagnostics are built, and `debug` is replaced by a collector so
 * nothing reaches the console. Both spies are restored by the caller.
 */
function captureDebugLines(): {
	lines: string[];
	restore: () => void;
} {
	const lines: string[] = [];
	const levelSpy = spyOn(Logger.prototype, "getLevel").mockReturnValue(
		LogLevel.DEBUG,
	);
	const debugSpy = spyOn(Logger.prototype, "debug").mockImplementation(
		(message: string) => {
			lines.push(message);
		},
	);
	return {
		lines,
		restore: () => {
			levelSpy.mockRestore();
			debugSpy.mockRestore();
		},
	};
}

describe("pool-liveness reserve — composite soft-demotion reorder (handleProxy)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		resetOverloadHoldSlots();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		resetHoldSlots();
		resetOverloadHoldSlots();
	});

	it("does NOT attempt an affinity-pinned reserved account first when a peer can absorb", async () => {
		// Pinned: 5% weekly headroom, healthy 5h, weekly resets in 5 days (well
		// beyond the release horizon) ⇒ inside the liveness reserve band.
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		// Peer: plenty of headroom on EVERY window ⇒ absorbable.
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 0, 95);
		seedUsage(peer.id, 20, 20);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		// TWO sequential requests through the same (pinning) strategy: the first
		// establishes the pin, the second is the affinity_hit the reserve must
		// still be able to reorder.
		const first = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		const second = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		// Every upstream attempt went to the peer — the reserved account was never
		// touched, on either request.
		expect(attempts).toEqual(["at-peer", "at-peer"]);
	});

	it("DOES attempt the reserved account first when no peer can absorb", async () => {
		// Both accounts are inside the reserve band: nobody can absorb, so the
		// reserve fails open and the pinned account keeps its place (rule 4).
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 0, 95);
		seedUsage(peer.id, 0, 95);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(attempts).toEqual(["at-pinned", "at-pinned"]);
	});

	it("releases the reserve inside the 12h horizon of the binding weekly reset", async () => {
		// Same shape as the demoting case, but the pinned account's weekly window
		// resets in 1h — holding the tail now would simply destroy it.
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 0, 95, HOUR);
		seedUsage(peer.id, 20, 20);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(attempts).toEqual(["at-pinned"]);
	});

	it("keeps an account demoted by neither gate in first place", async () => {
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 10, 20);
		seedUsage(peer.id, 20, 20);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(attempts).toEqual(["at-pinned"]);
	});

	it("demotes on the family-reservation gate alone (5h axis)", async () => {
		// Pinned's 5h session headroom is 20% (< the 25% family reserve) but its
		// weekly is wide open ⇒ family demotion only.
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 80, 20);
		seedUsage(peer.id, 20, 20);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(attempts).toEqual(["at-peer"]);
	});

	it("demotes on both gates at once and never promotes a family-reserved peer above a kept account", async () => {
		// pinned: 5h headroom 20 (family) AND weekly headroom 5 (liveness) ⇒ both.
		// familyOnly: 5h headroom 20 ⇒ family-demoted, and therefore NOT counted as
		//   an absorbable peer even though its minHeadroom is 20.
		// healthy: the only genuine absorber, and the only kept account.
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const familyOnly = makeAccount({
			id: "family-only",
			name: "FamilyOnly",
			access_token: "at-family-only",
		});
		const healthy = makeAccount({
			id: "healthy",
			name: "Healthy",
			access_token: "at-healthy",
		});
		seedUsage(pinned.id, 80, 95);
		seedUsage(familyOnly.id, 80, 20);
		seedUsage(healthy.id, 20, 20);

		const ctx = makeContext([pinned, familyOnly, healthy]);
		const attempts = recordAttempts(originalFetch);

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// The single kept account is served. A family-reserved account was never
		// promoted ahead of it — the composite partition is applied ONCE.
		expect(attempts).toEqual(["at-healthy"]);
	});

	it("still applies the reserve when the burst marker is INACTIVE (the dominant path)", async () => {
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 0, 95);
		seedUsage(peer.id, 20, 20);

		// Marker deliberately NOT set (beforeEach clears it): the burst preflight
		// takes the position-tested branch, sees the pinned account is no longer
		// the gated primary, and falls through to the normal loop.
		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(attempts).toEqual(["at-peer"]);
	});

	it("burst marker ACTIVE still holds the pinned account (documented scope boundary)", async () => {
		// The marker-active path is deliberately untouched by the reserve: it
		// handles a provider-family-wide per-IP burst where switching accounts does
		// not help, and it has its own exhaustion guards. Pinning this behavior
		// keeps the scope boundary from being eroded silently.
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 0, 95);
		seedUsage(peer.id, 20, 20);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		// First request establishes the pin (and is reordered onto the peer).
		await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);
		expect(attempts).toEqual(["at-peer"]);

		markAnthropicBurstThrottle();
		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		// The hold re-probed the pinned (cache-warm) account, not the peer.
		expect(attempts).toEqual(["at-peer", "at-pinned"]);
	});

	it("still applies the reserve on the overload-hold recovery re-selection", async () => {
		// Every candidate is behind the same provider-family overload bucket, so the
		// request holds. On wake the whole pipeline — including the composite
		// soft-demotion reorder — re-runs, so the reserve must still bind there.
		const pinned = makeAccount({
			id: "pinned",
			name: "Pinned",
			access_token: "at-pinned",
		});
		const peer = makeAccount({
			id: "peer",
			name: "Peer",
			access_token: "at-peer",
		});
		seedUsage(pinned.id, 0, 95);
		seedUsage(peer.id, 20, 20);

		const ctx = makeContext([pinned, peer]);
		const attempts = recordAttempts(originalFetch);

		// Open for ~300ms — well inside the hold budget.
		applyProviderOverloadCooldown(
			"anthropic",
			Date.now() + 300,
			"claude-sonnet-4-5",
		);

		const res = await callHandleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(res.status).toBe(200);
		expect(attempts).toEqual(["at-peer"]);
	}, 10_000);

	it("logs the account actually attempted, not the one in first position, when the late overload check skips accounts[0]", async () => {
		// The final-order DEBUG line is the ONLY runtime evidence that a soft
		// demotion bound, so it must follow the real upstream attempt rather than
		// list position. Here accounts[0] passes the EARLY provider-overload gate
		// and is then skipped by the LATE one inside the attempt loop:
		//   - the early gate reads each account's EFFECTIVE (mapped) model — opus
		//     for `first`, whose bucket is closed;
		//   - the late gate reads the REQUEST model (sonnet), whose bucket is open.
		// `second` sits behind a different provider overload key
		// (anthropic-compatible, not the collapsed anthropic-upstream key), so
		// neither gate touches it and it is the account really attempted.
		const first = makeAccount({
			id: "first",
			name: "First",
			access_token: "at-first",
			model_mappings: JSON.stringify({
				"claude-sonnet-4-5": "claude-opus-4-5",
			}),
		});
		const second = makeAccount({
			id: "second",
			name: "Second",
			provider: "anthropic-compatible",
			api_key: "ak-second",
			refresh_token: null,
			access_token: null,
		});
		// Healthy on every window: no soft demotion, so the candidate order is
		// exactly [first, second] and only the overload skip can move the attempt.
		seedUsage(first.id, 20, 20);
		seedUsage(second.id, 20, 20);

		const ctx = makeContext([first, second], makeOrderedStrategy());
		const attempts = recordAttempts(originalFetch);
		const debug = captureDebugLines();

		try {
			applyProviderOverloadCooldown(
				"anthropic",
				Date.now() + 60_000,
				"claude-sonnet-4-5",
			);

			const res = await callHandleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(res.status).toBe(200);
			// accounts[0] was never sent upstream.
			expect(attempts).toEqual(["ak-second"]);

			const line = debug.lines.find((l) =>
				l.startsWith("Final candidate order:"),
			);
			expect(line).toBeDefined();
			// Exactly one such line per request.
			expect(
				debug.lines.filter((l) => l.startsWith("Final candidate order:"))
					.length,
			).toBe(1);
			expect(line).toContain("First > Second");
			// The logged attempt is the account that actually went upstream…
			expect(line).toContain("attempted first upstream: second");
			// …while the by-position primary — the skipped account — is reported as
			// position, never as "the first attempt".
			expect(line).toContain("gated primary by position: first");
		} finally {
			debug.restore();
		}
	});
});
