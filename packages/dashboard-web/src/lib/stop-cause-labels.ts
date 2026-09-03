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
	pinned_target_unavailable: "Pinned target unavailable",
	provider_overloaded: "Provider overloaded",
	usage_throttled: "Usage throttled",
	context_window_exceeded: "Context window exceeded",
	upstream_error: "Upstream error",
	other: "Other",
};

/**
 * A distinct hue per cause, so a stacked bar can be read against the legend.
 *
 * The nine `CHART_TOKENS` roles plus muted grey for `other`. Assignment follows
 * `STOP_CAUSES` order except where a role carries meaning of its own: the
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
	other: "var(--muted-foreground)",
};
