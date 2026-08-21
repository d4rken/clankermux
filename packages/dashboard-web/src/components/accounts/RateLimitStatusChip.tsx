import { providerStatusToCause } from "@clankermux/core";
import type { RateLimitCause, UsageExhaustionBinding } from "@clankermux/types";
import type { ComponentProps } from "react";
import type { Badge } from "../ui/badge";
import { StatusChip } from "./StatusChip";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

// Old Badge variants → the light-tint color pairs used by the sibling status
// chips, so the rate-limit chip is the same size/weight as the rest.
const VARIANT_CLASSES: Record<NonNullable<BadgeVariant>, string> = {
	default: "bg-primary text-primary-foreground",
	secondary: "bg-secondary text-secondary-foreground",
	success: "bg-success/15 text-success-strong",
	warning:
		"bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
	destructive: "bg-destructive/15 text-destructive-strong",
	outline: "text-foreground",
};

interface StatusDescriptor {
	label: string;
	variant: NonNullable<BadgeVariant>;
	description: string;
}

/**
 * A spent quota is a routine, self-healing state rather than a provider fault,
 * so it gets the amber warning treatment rather than the red one — for both
 * window classes.
 *
 * The WORDING is binding-aware because the wait is wildly different: a 5-hour
 * session window resets in minutes, an account-wide weekly one can take days.
 * `null` (an older API payload, or the string path, which carries no binding)
 * gets deliberately non-committal wording rather than a guess.
 */
function usageExhaustedDescriptor(
	binding: UsageExhaustionBinding | null | undefined,
): StatusDescriptor {
	return {
		label: "Usage exhausted",
		variant: "warning",
		description:
			binding === "session"
				? "5-hour session quota is spent — requests resume when the window resets."
				: binding === "weekly"
					? "Weekly usage quota is spent — requests resume when the window resets."
					: "A usage quota is spent — requests resume when the window resets.",
	};
}

/** The binding-less form, used by the raw-status path and as the cause default. */
const USAGE_EXHAUSTED_DESCRIPTOR: StatusDescriptor =
	usageExhaustedDescriptor(null);

// Maps the provider's unified rate-limit status (e.g. the value of the
// `anthropic-ratelimit-unified-status` header) to a human-readable chip.
// Keys are normalized: lowercased with spaces collapsed to underscores.
const STATUS_MAP: Record<string, StatusDescriptor> = {
	allowed: {
		label: "Healthy",
		variant: "success",
		description: "Operating normally — well within the rate limit.",
	},
	allowed_warning: {
		label: "Near limit",
		variant: "warning",
		description:
			"Approaching the rate limit, but still serving requests normally.",
	},
	queueing_soft: {
		label: "Slowing down",
		variant: "warning",
		description:
			"The provider is softly queueing requests as the limit gets close.",
	},
	queueing_hard: {
		label: "Queued",
		variant: "destructive",
		description:
			"The provider is holding requests in a hard queue until the limit resets.",
	},
	rate_limited: {
		label: "Rate limited",
		variant: "destructive",
		description:
			"Blocked by the provider — requests are rejected until the limit resets.",
	},
	blocked: {
		label: "Blocked",
		variant: "destructive",
		description: "The provider has blocked this account.",
	},
	payment_required: {
		label: "Payment required",
		variant: "destructive",
		description: "The provider requires payment before serving more requests.",
	},
	// Anthropic emits `rejected` on a spent account; it means the provider is
	// refusing the request, so it reads as a rate limit rather than a grey unknown.
	rejected: {
		label: "Rate limited",
		variant: "destructive",
		description:
			"Blocked by the provider — requests are rejected until the limit resets.",
	},
	usage_exhausted: USAGE_EXHAUSTED_DESCRIPTOR,
};

/**
 * The chip for each normalized {@link RateLimitCause}. Preferred over parsing the
 * display string: the API resolves the cause and the string from ONE decision, so
 * keying on the cause cannot drift. `ok` has no chip (callers hide it).
 */
const CAUSE_MAP: Record<Exclude<RateLimitCause, "ok">, StatusDescriptor> = {
	allowed: STATUS_MAP.allowed,
	allowed_warning: STATUS_MAP.allowed_warning,
	queueing_soft: STATUS_MAP.queueing_soft,
	queueing_hard: STATUS_MAP.queueing_hard,
	rate_limited: STATUS_MAP.rate_limited,
	blocked: STATUS_MAP.blocked,
	payment_required: STATUS_MAP.payment_required,
	usage_exhausted: USAGE_EXHAUSTED_DESCRIPTOR,
	// Only reached when no raw provider status came with the cause — otherwise the
	// unrecognized value is rendered verbatim (humanized) by the string path
	// below, which is strictly more informative. Neutral, never red: an
	// unrecognized status is not evidence of a block.
	unknown: {
		label: "Unknown status",
		variant: "secondary",
		description:
			"The provider reported a rate-limit status this build does not recognize.",
	},
};

// Format a minute count as a compact human duration, e.g. 602 -> "10h 2m".
function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

// Title-case an unknown status token for a graceful fallback label.
function humanizeFallback(base: string): string {
	return base
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

interface ParsedStatus {
	descriptor: StatusDescriptor;
	resetMinutes: number | null;
}

// The backend formats the status as `<status>` or `<status> (<N>m)`, where N is
// minutes until the rate-limit window resets. Parse both parts out.
function parseStatus(raw: string): ParsedStatus {
	const match = raw.match(/^(.*?)\s*(?:\((\d+)m\))?$/);
	const rawBase = (match?.[1] ?? raw).trim();
	const resetMinutes = match?.[2] ? Number(match[2]) : null;
	const key = rawBase.toLowerCase().replace(/\s+/g, "_");

	const descriptor: StatusDescriptor = STATUS_MAP[key] ?? {
		label: humanizeFallback(rawBase) || rawBase,
		variant: "secondary",
		description: `Provider rate-limit status: ${rawBase}`,
	};

	return { descriptor, resetMinutes };
}

interface RateLimitStatusChipProps {
	/**
	 * Raw status string from the API, e.g. `allowed (242m)`. Used as the fallback
	 * for callers that have no structured cause (older payloads, legacy shapes).
	 */
	status: string;
	/** Normalized cause from the API — preferred over parsing `status`. */
	cause?: RateLimitCause | null;
	/**
	 * Which account-wide window drove a `usage_exhausted` cause. Only the tooltip
	 * wording depends on it; null/absent (older payloads, or the raw-status path)
	 * yields the generic explanation.
	 */
	binding?: UsageExhaustionBinding | null;
	/** Epoch ms when the cause clears; drives the countdown when `cause` is set. */
	resetMs?: number | null;
	/**
	 * Raw stored provider status. When it is a value the shared vocabulary does
	 * not recognize, its humanized label is more informative than the generic
	 * cause the resolver normalized it to, so the string path wins.
	 */
	providerStatus?: string | null;
	/** Injectable clock (tests). */
	now?: number;
}

export function RateLimitStatusChip({
	status,
	cause = null,
	binding = null,
	resetMs = null,
	providerStatus = null,
	now = Date.now(),
}: RateLimitStatusChipProps) {
	const parsed = parseStatus(status);
	const isUnknownProviderStatus =
		!!providerStatus && providerStatusToCause(providerStatus) === null;
	// Prefer the structured cause, except when it is a normalization of a provider
	// status we don't know (keep that one verbatim) — `usage_exhausted` is derived
	// from usage data, not from the provider status, so it always wins. It is also
	// the one cause whose wording depends on WHICH window is spent.
	const causeDescriptor =
		cause !== null &&
		cause !== "ok" &&
		(cause === "usage_exhausted" || !isUnknownProviderStatus)
			? cause === "usage_exhausted"
				? usageExhaustedDescriptor(binding)
				: CAUSE_MAP[cause]
			: null;
	const useCause = causeDescriptor !== null;
	const descriptor = causeDescriptor ?? parsed.descriptor;
	const resetMinutes = useCause
		? resetMs !== null && resetMs > now
			? Math.ceil((resetMs - now) / 60000)
			: null
		: parsed.resetMinutes;
	const resetLabel =
		resetMinutes !== null && resetMinutes > 0
			? formatMinutes(resetMinutes)
			: null;

	const title = resetLabel
		? `${descriptor.description} Resets in ${resetLabel}.`
		: descriptor.description;

	return (
		<StatusChip className={VARIANT_CLASSES[descriptor.variant]} title={title}>
			{descriptor.label}
			{resetLabel && (
				<span className="font-normal opacity-80">· {resetLabel}</span>
			)}
		</StatusChip>
	);
}
