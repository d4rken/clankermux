/** Claude-1's mixed quota rejection, 2026-09-07T19:47:06.554Z. */
export const QUOTA_INCIDENT_NOW = 1_788_810_426_554;
export const QUOTA_INCIDENT_SESSION_RESET = 1_788_822_000_000;
export const QUOTA_INCIDENT_WEEKLY_RESET = 1_789_282_800_000;

export function quotaIncidentResponse(
	overrides: Record<string, string | null> = {},
): Response {
	const headers = new Headers({
		"content-type": "application/json",
		"anthropic-ratelimit-unified-5h-reset": "1788822000",
		"anthropic-ratelimit-unified-5h-status": "rejected",
		"anthropic-ratelimit-unified-5h-utilization": "1.01",
		"anthropic-ratelimit-unified-7d-reset": "1789282800",
		"anthropic-ratelimit-unified-7d-status": "allowed",
		"anthropic-ratelimit-unified-7d-utilization": "0.55",
		"anthropic-ratelimit-unified-7d_oi-reset": "1789282800",
		"anthropic-ratelimit-unified-7d_oi-status": "rejected",
		"anthropic-ratelimit-unified-7d_oi-utilization": "1.0",
		"anthropic-ratelimit-unified-representative-claim":
			"seven_day_overage_included",
		"anthropic-ratelimit-unified-reset": "1789282800",
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
		"retry-after": "472373",
		"x-should-retry": "true",
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (value === null) headers.delete(key);
		else headers.set(key, value);
	}
	return new Response(
		'{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
		{
			status: 429,
			headers,
		},
	);
}
