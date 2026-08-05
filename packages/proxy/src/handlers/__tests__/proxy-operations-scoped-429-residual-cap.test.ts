import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { usageCache } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { clearProviderOverloadCooldown } from "../../provider-overload-cooldown";
import { clearAnthropicBurstThrottle } from "../burst-cooldown";
import {
	capResidualRung429Cooldown,
	proxyWithAccount,
	RESIDUAL_429_COOLDOWN_CAP_MS,
} from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { BURST_RETRY_COOLDOWN_CAP_MS } from "../transparent-retry";

/**
 * The residual 429 rungs (`model_fallback_429`, `all_models_exhausted_429`)
 * are by construction the residue after every evidence-gated rung declined —
 * they possess NO corroborating account-wide evidence, so they must never
 * write an unbounded account-wide lock. Historically they copied
 * `extractCooldownUntil` (i.e. the 429's `retry-after`) verbatim: on a
 * claim-scoped 429 that slipped past the family rung this was the SCOPED
 * claim's reset — observed 4.5 days — under a reason the poller's
 * capacity-restored release is forbidden to clear (the 2026-08-02 incident).
 *
 * Two caps now apply (capResidualRung429Cooldown):
 *  - provably scoped-only rejection on a trusted official-Anthropic account →
 *    the same ~90s cap the re-probe and burst-intercept rungs already use;
 *  - everything else → a flat 24h ceiling (honest short retry-afters pass
 *    through verbatim; multi-day/headerless pathologies are bounded).
 */
const INCIDENT_NOW = 1_785_684_988_613; // 2026-08-02T15:36:28.613Z
const INCIDENT_5H_RESET_MS = 1_785_685_200_000;

/** Verbatim production headers of 2026-08-02T15:36:28Z (scoped-only shape). */
function scopedIncidentHeaders(): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-5h-reset": "1785685200",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-5h-utilization": "0.0",
		"anthropic-ratelimit-unified-7d-reset": "1785736800",
		"anthropic-ratelimit-unified-7d-status": "allowed_warning",
		"anthropic-ratelimit-unified-7d-utilization": "0.94",
		"anthropic-ratelimit-unified-7d_oi-reset": "1785736800",
		"anthropic-ratelimit-unified-7d_oi-status": "rejected",
		"anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
		"anthropic-ratelimit-unified-reset": "1785736800",
		"anthropic-ratelimit-unified-status": "rejected",
		"retry-after": "51811", // the scoped claim's reset as delta-seconds (14.4h)
	};
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-oauth",
		name: "oauth-cache",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt-token",
		access_token: "at-token",
		expires_at: INCIDENT_NOW + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: INCIDENT_NOW,
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-cap-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: INCIDENT_NOW,
		headers: new Headers(),
	};
}

// An unrecognized model resolves to NO family, so the family-weekly rung's
// header fallback declines (it cannot name the exhausted family) and — with
// no model list either — the flow reaches the no-fallback residual rung.
// This is exactly the evidence-starved gap the cap exists for.
function makeRequestBody(model = "totally-unknown-model") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

type CooldownCall = { accountId: string; until: number; reason: string };

function makeProxyContext() {
	const deadlineCalls: CooldownCall[] = [];
	const escalatingCalls: CooldownCall[] = [];
	const metaCalls: Array<{ status: string; resetTime: number | null }> = [];
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(accountId: string, until: number, reason: string) => {
					escalatingCalls.push({ accountId, until, reason });
					return Promise.resolve(1);
				},
			),
			markAccountRateLimitedDeadlineOnly: mock(
				(accountId: string, until: number, reason: string) => {
					deadlineCalls.push({ accountId, until, reason });
					return Promise.resolve();
				},
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(
				(
					_accountId: string,
					status: string,
					resetTime: number | null,
					_remaining: number | undefined,
				) => {
					metaCalls.push({ status, resetTime });
					return Promise.resolve();
				},
			),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: (response: Response) => {
				const statusHeader =
					response.headers.get("anthropic-ratelimit-unified-status") ??
					undefined;
				const resetHeader = response.headers.get(
					"anthropic-ratelimit-unified-reset",
				);
				return {
					isRateLimited: response.status === 429,
					resetTime: resetHeader ? Number(resetHeader) * 1000 : undefined,
					statusHeader,
					remaining: undefined,
				};
			},
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
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
	} as unknown as ProxyContext;
	return { ctx, deadlineCalls, escalatingCalls, metaCalls };
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function rl429(headers: Record<string, string>) {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "Too many requests" },
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", ...headers },
		},
	);
}

async function drive(
	ctx: ProxyContext,
	account: Account,
	model?: string,
): Promise<Response | null> {
	const bodyBuffer = makeRequestBody(model);
	return proxyWithAccount(
		makeRequest(bodyBuffer),
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		bodyBuffer,
		() => undefined,
		0,
		ctx,
	);
}

describe("capResidualRung429Cooldown (unit)", () => {
	const farFuture = INCIDENT_NOW + 4.5 * 24 * 60 * 60 * 1000;

	it("caps a provably scoped-only rejection on a trusted account at the burst cap", () => {
		expect(
			capResidualRung429Cooldown(
				makeAccount(),
				rl429(scopedIncidentHeaders()),
				farFuture,
				INCIDENT_NOW,
			),
		).toBe(INCIDENT_NOW + BURST_RETRY_COOLDOWN_CAP_MS);
	});

	it("applies the flat 24h ceiling for a custom-endpoint account (untrusted headers)", () => {
		expect(
			capResidualRung429Cooldown(
				makeAccount({ custom_endpoint: "https://proxy.example" }),
				rl429(scopedIncidentHeaders()),
				farFuture,
				INCIDENT_NOW,
			),
		).toBe(INCIDENT_NOW + RESIDUAL_429_COOLDOWN_CAP_MS);
	});

	it("applies the flat 24h ceiling for a codex account (no unified headers)", () => {
		expect(
			capResidualRung429Cooldown(
				makeAccount({ provider: "codex" }),
				rl429({ "retry-after": "2592000" }),
				farFuture,
				INCIDENT_NOW,
			),
		).toBe(INCIDENT_NOW + RESIDUAL_429_COOLDOWN_CAP_MS);
	});

	it("passes an honest short deadline through verbatim", () => {
		const honest = INCIDENT_NOW + 3_600_000;
		expect(
			capResidualRung429Cooldown(
				makeAccount(),
				rl429({ "anthropic-ratelimit-unified-status": "rejected" }),
				honest,
				INCIDENT_NOW,
			),
		).toBe(honest);
	});
});

describe("proxyWithAccount — residual rung 429 cooldown caps", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		setSystemTime(new Date(INCIDENT_NOW));
		originalFetch = globalThis.fetch;
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete("acc-oauth");
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setSystemTime();
		clearProviderOverloadCooldown();
		clearAnthropicBurstThrottle();
		usageCache.delete("acc-oauth");
	});

	it("scoped incident 429 reaching the no-fallback rung: ~90s cap, reason model_fallback_429", async () => {
		globalThis.fetch = mock(async () => rl429(scopedIncidentHeaders()));
		const { ctx, deadlineCalls, escalatingCalls, metaCalls } =
			makeProxyContext();

		const result = await drive(ctx, makeAccount());

		expect(result).toBeNull();
		const call = [...deadlineCalls, ...escalatingCalls].find(
			(c) => c.reason === "model_fallback_429",
		);
		expect(call).toBeDefined();
		expect((call as CooldownCall).until).toBeLessThanOrEqual(
			INCIDENT_NOW + BURST_RETRY_COOLDOWN_CAP_MS,
		);
		// The scoped projection also keeps the persisted meta honest: the 5h
		// claim's own pair, never the summary rejected + weekly epoch.
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual({
			status: "allowed",
			resetTime: INCIDENT_5H_RESET_MS,
		});
	});

	it("same scoped 429 on a custom-endpoint account: flat 24h cap (headers untrusted)", async () => {
		globalThis.fetch = mock(async () => rl429(scopedIncidentHeaders()));
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();

		const result = await drive(
			ctx,
			makeAccount({ custom_endpoint: "https://proxy.example" }),
		);

		expect(result).toBeNull();
		const call = [...deadlineCalls, ...escalatingCalls].find(
			(c) => c.reason === "model_fallback_429",
		);
		expect(call).toBeDefined();
		// retry-after 51811s (14.4h) < 24h → the honest value passes through.
		expect((call as CooldownCall).until).toBe(INCIDENT_NOW + 51_811_000);
	});

	it("genuine account-wide 429 with an honest retry-after is honored verbatim", async () => {
		globalThis.fetch = mock(async () =>
			rl429({
				"anthropic-ratelimit-unified-7d-status": "rejected",
				"anthropic-ratelimit-unified-7d-utilization": "1.0",
				"anthropic-ratelimit-unified-status": "rejected",
				"retry-after": "3600",
			}),
		);
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();

		const result = await drive(ctx, makeAccount());

		expect(result).toBeNull();
		const call = [...deadlineCalls, ...escalatingCalls].find(
			(c) => c.reason === "model_fallback_429",
		);
		expect(call).toBeDefined();
		expect((call as CooldownCall).until).toBe(INCIDENT_NOW + 3_600_000);
	});

	it("headerless multi-day retry-after is bounded by the 24h ceiling", async () => {
		globalThis.fetch = mock(
			async () => rl429({ "retry-after": "2592000" }), // 30 days, no unified headers
		);
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();

		const result = await drive(ctx, makeAccount());

		expect(result).toBeNull();
		const call = [...deadlineCalls, ...escalatingCalls].find(
			(c) => c.reason === "model_fallback_429",
		);
		expect(call).toBeDefined();
		expect((call as CooldownCall).until).toBe(
			INCIDENT_NOW + RESIDUAL_429_COOLDOWN_CAP_MS,
		);
	});

	it("all-models-exhausted rung is capped too (custom-endpoint scoped shape, 24h)", async () => {
		globalThis.fetch = mock(async () =>
			rl429({ ...scopedIncidentHeaders(), "retry-after": "2592000" }),
		);
		const { ctx, deadlineCalls, escalatingCalls } = makeProxyContext();

		const result = await drive(
			ctx,
			makeAccount({
				custom_endpoint: "https://proxy.example",
				model_mappings: JSON.stringify({ sonnet: "claude-sonnet-4-5" }),
				model_fallbacks: JSON.stringify({ sonnet: "claude-haiku-4-5" }),
			}),
			"claude-sonnet-4-5",
		);

		expect(result).toBeNull();
		const call = [...deadlineCalls, ...escalatingCalls].find(
			(c) => c.reason === "all_models_exhausted_429",
		);
		expect(call).toBeDefined();
		expect((call as CooldownCall).until).toBeLessThanOrEqual(
			INCIDENT_NOW + RESIDUAL_429_COOLDOWN_CAP_MS,
		);
	});
});
