import type { StopCause } from "@clankermux/types";
import { CHART_TOKENS } from "../constants";

/**
 * Human wording for each stop cause.
 *
 * The wire values are the proxy's own vocabulary and read as internals
 * (`model_not_served`, `oauth_tokens_expired`); the labels say what actually
 * happened to a request. Exhaustive over `StopCause` by type, so adding a cause
 * to the union without a label here is a build failure rather than a blank
 * table row.
 */
export const STOP_CAUSE_LABELS: Record<StopCause, string> = {
	pool_quota_exhausted: "Pool quota exhausted",
	family_weekly_exhausted: "Model weekly limit",
	model_not_served: "Model not served by any account",
	oauth_tokens_expired: "OAuth tokens expired",
	pinned_target_unavailable: "Destination unavailable",
	provider_overloaded: "Provider overloaded",
	usage_throttled: "Usage throttled",
	context_window_exceeded: "Context window exceeded",
	upstream_error: "Upstream error",
	client_disconnected: "Client disconnected",
	request_timed_out: "Request timed out",
	stream_failed: "Stream failed",
	stream_limited: "Stream rate limited or overloaded",
	all_accounts_failed: "All accounts failed",
	other: "Unclassified",
};

/**
 * A distinct hue per cause, so a stacked bar can be read against the legend.
 *
 * Theme roles and derived tints distinguish causes; disconnects and unknown
 * outcomes use muted shades. A role can carry meaning of its own: the
 * success hue is not handed to whichever cause the list order happens to put
 * there. `other` is deliberately outside the palette: it is the bucket for
 * terminals nobody has classified yet, not a cause of its own, and giving it a
 * hue of equal weight would make an unclassified spike look like a named
 * failure mode.
 */
export const STOP_CAUSE_COLORS: Record<StopCause, string> = {
	pool_quota_exhausted: CHART_TOKENS.primary,
	family_weekly_exhausted: CHART_TOKENS.pink,
	model_not_served: CHART_TOKENS.warning,
	oauth_tokens_expired: CHART_TOKENS.error,
	pinned_target_unavailable: CHART_TOKENS.blue,
	provider_overloaded: CHART_TOKENS.purple,
	// The one cause allowed the success hue: it is the proxy's own deliberate
	// pacing, not a failure of anything.
	usage_throttled: CHART_TOKENS.success,
	context_window_exceeded: CHART_TOKENS.indigo,
	upstream_error: CHART_TOKENS.cyan,
	client_disconnected:
		"color-mix(in oklch, var(--muted-foreground) 70%, var(--background))",
	request_timed_out:
		"color-mix(in oklch, var(--chart-blue) 65%, var(--foreground))",
	stream_failed:
		"color-mix(in oklch, var(--destructive) 75%, var(--foreground))",
	stream_limited:
		"color-mix(in oklch, var(--chart-pink) 65%, var(--foreground))",
	all_accounts_failed:
		"color-mix(in oklch, var(--chart-purple) 65%, var(--foreground))",
	other: "var(--muted-foreground)",
};
