import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { AnthropicProvider } from "../provider";

/**
 * parseRateLimit's non-529 branch historically returned the unified reset
 * VERBATIM. On a claim-scoped 429 (`7d_oi` rejected, account-wide headroom)
 * the summary reset is the SCOPED claim's — observed 4.5 days out — and the
 * unclamped value flowed into `accounts.rate_limit_reset` and the generic
 * cooldown path as an account-wide deadline. 429 resets are now clamped to
 * the same 24h ceiling the 529 branch has always used; 200 responses keep
 * the raw value (window-anchor semantics, consumed by the auto-refresh
 * scheduler).
 *
 * The incident fixture's epochs are fixed in the past, so every test freezes
 * the clock — parseRateLimit reads Date.now() internally.
 */
const INCIDENT_NOW = 1_785_684_988_613; // 2026-08-02T15:36:28.613Z
const DAY_MS = 24 * 60 * 60 * 1000;

const provider = new AnthropicProvider();

function response(status: number, headers: Record<string, string>): Response {
	return new Response(status === 200 ? "{}" : null, { status, headers });
}

beforeEach(() => {
	setSystemTime(new Date(INCIDENT_NOW));
});

afterEach(() => {
	setSystemTime();
});

describe("AnthropicProvider.parseRateLimit 429 reset clamping", () => {
	it("clamps a multi-day unified reset on a 429 to 24h from now", () => {
		// The 2026-08-04 incident value: unified reset ≈ 4.7 days out.
		const weeklyEpochSec = Math.floor((INCIDENT_NOW + 4.7 * DAY_MS) / 1000);
		const info = provider.parseRateLimit(
			response(429, {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": String(weeklyEpochSec),
			}),
		);
		expect(info.isRateLimited).toBe(true);
		expect(info.statusHeader).toBe("rejected");
		expect(info.resetTime).toBe(INCIDENT_NOW + DAY_MS);
	});

	it("keeps an honest short unified reset on a 429 verbatim", () => {
		const twoHoursOutSec = Math.floor(
			(INCIDENT_NOW + 2 * 60 * 60 * 1000) / 1000,
		);
		const info = provider.parseRateLimit(
			response(429, {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": String(twoHoursOutSec),
			}),
		);
		expect(info.resetTime).toBe(twoHoursOutSec * 1000);
	});

	it("drops a past unified reset on a 429 (no-reset cooldown path fires)", () => {
		const pastSec = Math.floor((INCIDENT_NOW - 60_000) / 1000);
		const info = provider.parseRateLimit(
			response(429, {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": String(pastSec),
			}),
		);
		expect(info.isRateLimited).toBe(true);
		expect(info.resetTime).toBeUndefined();
	});

	it("leaves a 200's unified reset unclamped (window-anchor semantics unchanged)", () => {
		const weeklyEpochSec = Math.floor((INCIDENT_NOW + 4.7 * DAY_MS) / 1000);
		const info = provider.parseRateLimit(
			response(200, {
				"anthropic-ratelimit-unified-status": "allowed",
				"anthropic-ratelimit-unified-reset": String(weeklyEpochSec),
			}),
		);
		expect(info.isRateLimited).toBe(false);
		expect(info.resetTime).toBe(weeklyEpochSec * 1000);
	});

	it("still synthesizes now+60s for a bare 429 with no headers", () => {
		const info = provider.parseRateLimit(response(429, {}));
		expect(info.isRateLimited).toBe(true);
		expect(info.resetTime).toBe(INCIDENT_NOW + 60_000);
	});
});
