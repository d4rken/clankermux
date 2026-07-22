import type { ComponentProps } from "react";
import type { Badge } from "../ui/badge";
import { StatusChip } from "./StatusChip";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

// Old Badge variants → the light-tint color pairs used by the sibling status
// chips, so the rate-limit chip is the same size/weight as the rest.
const VARIANT_CLASSES: Record<NonNullable<BadgeVariant>, string> = {
	default: "bg-primary text-primary-foreground",
	secondary: "bg-secondary text-secondary-foreground",
	success:
		"bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
	warning:
		"bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
	destructive: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
	outline: "text-foreground",
};

interface StatusDescriptor {
	label: string;
	variant: NonNullable<BadgeVariant>;
	description: string;
}

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
	/** Raw status string from the API, e.g. `allowed (242m)`. */
	status: string;
}

export function RateLimitStatusChip({ status }: RateLimitStatusChipProps) {
	const { descriptor, resetMinutes } = parseStatus(status);
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
