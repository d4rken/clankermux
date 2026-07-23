import { describe, expect, it } from "bun:test";
import {
	CODEX_USAGE_STATUS_ENDPOINT,
	fetchCodexUsageStatus,
	parseCodexUsageStatus,
} from "../usage-status";

const NOW_MS = 1_700_000_000_000; // fixed base for deterministic reset math
const now = () => NOW_MS;

// A full happy-path body: 5h primary (SECONDS), 7d secondary, paid credits, and
// an inline reset-credit summary. Mirrors RateLimitStatusPayload +
// RateLimitStatusDetails + RateLimitWindowSnapshot + CreditStatusDetails.
function fullBody() {
	return {
		plan_type: "pro",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: {
				used_percent: 42,
				limit_window_seconds: 5 * 60 * 60, // 18000 → five_hour
				reset_after_seconds: 3600,
				reset_at: 1_700_000_500,
			},
			secondary_window: {
				used_percent: 73,
				limit_window_seconds: 7 * 24 * 60 * 60, // 604800 → seven_day
				reset_after_seconds: 100_000,
				reset_at: 1_700_100_000,
			},
		},
		credits: {
			has_credits: true,
			unlimited: false,
			balance: "12.345",
		},
		rate_limit_reset_credits: { available_count: 2 },
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const stubFetch = (response: Response): typeof fetch =>
	(async () => response) as unknown as typeof fetch;

describe("parseCodexUsageStatus", () => {
	it("parses both windows, flags, and credits on the happy path", () => {
		const status = parseCodexUsageStatus(fullBody(), 200, NOW_MS);

		expect(status.ok).toBe(true);
		expect(status.status).toBe(200);
		expect(status.allowed).toBe(true);
		expect(status.limitReached).toBe(false);
		expect(status.resetCreditsAvailableCount).toBe(2);

		expect(status.usage).not.toBeNull();
		expect(status.usage?.five_hour?.utilization).toBe(42);
		expect(status.usage?.seven_day.utilization).toBe(73);
		expect(status.usage?.codexCredits).toEqual({
			hasCredits: true,
			balance: 12.35, // rounded to 2 decimals
			unlimited: false,
			planType: "pro",
			weeklyUsedPct: 73,
		});
	});

	it("slots windows by SECONDS not minutes", () => {
		// 18000s is 5h; a naive minutes reading (300) would also be 5h, but 604800s
		// must be 7d — a minutes reading (10080) would mis-slot. Prove seconds win.
		const status = parseCodexUsageStatus(fullBody(), 200, NOW_MS);
		expect(status.usage?.five_hour?.utilization).toBe(42);
		expect(status.usage?.seven_day.utilization).toBe(73);
	});

	it("prefers reset_at over reset_after_seconds", () => {
		const status = parseCodexUsageStatus(fullBody(), 200, NOW_MS);
		// reset_at 1_700_000_500 (epoch s) → ISO, NOT now + reset_after_seconds.
		expect(status.usage?.five_hour?.resets_at).toBe(
			new Date(1_700_000_500 * 1_000).toISOString(),
		);
	});

	it("falls back to now + reset_after_seconds when reset_at is absent/zero", () => {
		const body = fullBody();
		body.rate_limit.primary_window.reset_at = 0;
		const status = parseCodexUsageStatus(body, 200, NOW_MS);
		expect(status.usage?.five_hour?.resets_at).toBe(
			new Date(NOW_MS + 3600 * 1_000).toISOString(),
		);
	});

	it("ignores additional_rate_limits without crashing", () => {
		const body = {
			...fullBody(),
			additional_rate_limits: [
				{
					limit_name: "codex",
					metered_feature: "codex",
					rate_limit: { allowed: false, limit_reached: true },
				},
			],
		};
		const status = parseCodexUsageStatus(body, 200, NOW_MS);
		expect(status.ok).toBe(true);
		// Root rate_limit still drives allowed/limitReached, not the extra entry.
		expect(status.allowed).toBe(true);
		expect(status.limitReached).toBe(false);
		expect(status.usage?.five_hour?.utilization).toBe(42);
	});

	it("surfaces limit_reached / allowed / reached-type for an exhausted account", () => {
		const body = fullBody();
		body.rate_limit.allowed = false;
		body.rate_limit.limit_reached = true;
		const withType = {
			...body,
			rate_limit_reached_type: { type: "rate_limit_reached" },
		};
		const status = parseCodexUsageStatus(withType, 200, NOW_MS);
		expect(status.ok).toBe(true);
		expect(status.allowed).toBe(false);
		expect(status.limitReached).toBe(true);
		expect(status.rateLimitReachedType).toBe("rate_limit_reached");
	});

	it("emits five_hour: null (not a 0% placeholder) when only a weekly window is present", () => {
		// Codex retired its rolling 5h window; a weekly-only /wham/usage read must
		// leave five_hour null rather than fabricating a `{0, null}` card that is
		// indistinguishable from Anthropic's genuine idle 5h window.
		const body = {
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 73,
					limit_window_seconds: 7 * 24 * 60 * 60, // 604800 → seven_day
					reset_after_seconds: 100_000,
					reset_at: 1_700_100_000,
				},
			},
		};
		const status = parseCodexUsageStatus(body, 200, NOW_MS);
		expect(status.usage).not.toBeNull();
		expect(status.usage?.five_hour).toBeNull();
		expect(status.usage?.seven_day.utilization).toBe(73);
	});

	it("returns usage null but ok:true for empty/placeholder windows", () => {
		const body = {
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: {
					used_percent: 0,
					limit_window_seconds: 0,
					reset_after_seconds: 0,
					reset_at: 0,
				},
				secondary_window: {
					used_percent: 0,
					limit_window_seconds: 0,
					reset_after_seconds: 0,
					reset_at: 0,
				},
			},
		};
		const status = parseCodexUsageStatus(body, 200, NOW_MS);
		expect(status.ok).toBe(true);
		expect(status.usage).toBeNull();
		expect(status.allowed).toBe(true);
	});

	it("omits codexCredits when the credits object is absent", () => {
		const { credits: _omitted, ...body } = fullBody();
		const status = parseCodexUsageStatus(body, 200, NOW_MS);
		expect(status.usage).not.toBeNull();
		expect(status.usage?.codexCredits).toBeUndefined();
	});

	it("returns ok:false on a non-object body (parse-shape failure)", () => {
		const status = parseCodexUsageStatus("not-an-object", 200, NOW_MS);
		expect(status.ok).toBe(false);
		expect(status.status).toBe(200);
		expect(status.usage).toBeNull();
	});
});

describe("fetchCodexUsageStatus", () => {
	it("GETs the canonical endpoint with auth + account-id headers", async () => {
		let captured: { url: string; init: RequestInit } | null = null;
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			captured = { url: String(input), init: init ?? {} };
			return jsonResponse(fullBody());
		}) as unknown as typeof fetch;

		const status = await fetchCodexUsageStatus({
			accessToken: "tok-123",
			chatgptAccountId: "acct-abc",
			fetchImpl,
			now,
		});

		expect(status.ok).toBe(true);
		expect(captured).not.toBeNull();
		const cap = captured as unknown as { url: string; init: RequestInit };
		expect(cap.url).toBe(CODEX_USAGE_STATUS_ENDPOINT);
		expect(cap.init.method).toBe("GET");
		const headers = new Headers(cap.init.headers);
		expect(headers.get("Authorization")).toBe("Bearer tok-123");
		expect(headers.get("ChatGPT-Account-ID")).toBe("acct-abc");
	});

	it("omits the account-id header when chatgptAccountId is null", async () => {
		let captured: RequestInit | null = null;
		const fetchImpl = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			captured = init ?? {};
			return jsonResponse(fullBody());
		}) as unknown as typeof fetch;

		await fetchCodexUsageStatus({
			accessToken: "tok-123",
			chatgptAccountId: null,
			fetchImpl,
			now,
		});

		const headers = new Headers((captured as unknown as RequestInit).headers);
		expect(headers.get("ChatGPT-Account-ID")).toBeNull();
	});

	it("returns ok:false / status:404 on a 404 (fallback-probe signal for 1b)", async () => {
		const status = await fetchCodexUsageStatus({
			accessToken: "tok",
			chatgptAccountId: "acct",
			fetchImpl: stubFetch(jsonResponse({}, 404)),
			now,
		});
		expect(status.ok).toBe(false);
		expect(status.status).toBe(404);
		expect(status.usage).toBeNull();
	});

	it("returns ok:false / status:429 on a rate-limited response (no probe)", async () => {
		const status = await fetchCodexUsageStatus({
			accessToken: "tok",
			chatgptAccountId: "acct",
			fetchImpl: stubFetch(jsonResponse({}, 429)),
			now,
		});
		expect(status.ok).toBe(false);
		expect(status.status).toBe(429);
	});

	it("returns ok:false / status:null on a network throw", async () => {
		const fetchImpl = (async () => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const status = await fetchCodexUsageStatus({
			accessToken: "tok",
			chatgptAccountId: "acct",
			fetchImpl,
			now,
		});
		expect(status.ok).toBe(false);
		expect(status.status).toBeNull();
	});

	it("returns ok:false on HTTP 200 with a non-JSON body", async () => {
		const badResponse = new Response("<html>not json</html>", { status: 200 });
		const status = await fetchCodexUsageStatus({
			accessToken: "tok",
			chatgptAccountId: "acct",
			fetchImpl: stubFetch(badResponse),
			now,
		});
		expect(status.ok).toBe(false);
		expect(status.status).toBe(200);
	});
});
