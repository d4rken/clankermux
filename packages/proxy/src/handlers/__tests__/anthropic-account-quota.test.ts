import { describe, expect, it } from "bun:test";
import { resolveLiveAccountQuota429 } from "../anthropic-account-quota";
import {
	QUOTA_INCIDENT_NOW as NOW,
	quotaIncidentResponse,
	QUOTA_INCIDENT_SESSION_RESET as SESSION_RESET,
	QUOTA_INCIDENT_WEEKLY_RESET as WEEKLY_RESET,
} from "./anthropic-quota-incident.fixture";

const account = { provider: "anthropic", custom_endpoint: null };
const HOUR = 3_600_000;

describe("resolveLiveAccountQuota429", () => {
	it("uses the five-hour claim despite the summary's scoped weekly reset", () => {
		expect(
			resolveLiveAccountQuota429(account, quotaIncidentResponse(), NOW),
		).toEqual({
			reason: "session_exhausted_429",
			binding: "session",
			resetTime: SESSION_RESET,
		});
	});

	it("honors a real account weekly reset beyond 24 hours", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-5h-status": "allowed",
					"anthropic-ratelimit-unified-7d-status": "rejected",
				}),
				NOW,
			),
		).toEqual({
			reason: "weekly_exhausted_429",
			binding: "weekly",
			resetTime: WEEKLY_RESET,
		});
	});

	it("keeps the weekly cause but waits for both account-wide windows", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-7d-status": "rejected",
					"anthropic-ratelimit-unified-7d-reset": String((NOW + HOUR) / 1000),
				}),
				NOW,
			),
		).toEqual({
			reason: "weekly_exhausted_429",
			binding: "weekly",
			resetTime: SESSION_RESET,
		});
	});

	it.each([
		null,
		"",
		"0",
		"NaN",
		"Infinity",
		"1788822000x",
		"1788822000, 1788822001",
		"9007199254740992",
		String((NOW - 1000) / 1000),
		String((NOW + 6 * HOUR) / 1000),
	])("leaves an unusable five-hour reset to adaptive quota backoff: %s", (reset) => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-5h-reset": reset,
				}),
				NOW,
			),
		).toEqual({
			reason: "session_exhausted_429",
			binding: "session",
			resetTime: undefined,
		});
	});

	it("retains a valid rejected claim's deadline when another reset is malformed", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-7d-status": "rejected",
					"anthropic-ratelimit-unified-7d-reset": "invalid",
				}),
				NOW,
			)?.resetTime,
		).toBe(SESSION_RESET);
	});

	it("rejects implausible weekly resets rather than manufacturing a long lock", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-5h-status": "allowed",
					"anthropic-ratelimit-unified-7d-status": "rejected",
					"anthropic-ratelimit-unified-7d-reset": String(
						(NOW + 8 * 24 * HOUR) / 1000,
					),
				}),
				NOW,
			)?.resetTime,
		).toBeUndefined();
	});

	it("does not convert scoped-only rejection or a headerless burst into account quota", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-5h-status": "allowed",
					"anthropic-ratelimit-unified-5h-utilization": "0.2",
				}),
				NOW,
			),
		).toBeNull();
		expect(
			resolveLiveAccountQuota429(
				account,
				new Response(null, { status: 429 }),
				NOW,
			),
		).toBeNull();
	});

	it("ignores unknown claim status and utilization without explicit rejection", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-5h-status": "future_status",
				}),
				NOW,
			),
		).toBeNull();
	});

	it("leaves billing depletion to its own handler", () => {
		expect(
			resolveLiveAccountQuota429(
				account,
				quotaIncidentResponse({
					"anthropic-ratelimit-unified-overage-disabled-reason":
						"out_of_credits",
				}),
				NOW,
			),
		).toBeNull();
	});

	it("trusts only official Anthropic 429s", () => {
		expect(
			resolveLiveAccountQuota429(
				{ ...account, custom_endpoint: "https://proxy.example" },
				quotaIncidentResponse(),
				NOW,
			),
		).toBeNull();
		expect(
			resolveLiveAccountQuota429(
				{ ...account, provider: "codex" },
				quotaIncidentResponse(),
				NOW,
			),
		).toBeNull();
		for (const status of [200, 529]) {
			expect(
				resolveLiveAccountQuota429(
					account,
					new Response(null, {
						status,
						headers: quotaIncidentResponse().headers,
					}),
					NOW,
				),
			).toBeNull();
		}
	});
});
