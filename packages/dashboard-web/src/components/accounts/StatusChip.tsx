import type { ComponentPropsWithoutRef } from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * Shared status pill used across the account chip cluster (Primary, Priority,
 * rate-limit, provider-overload, renewal, OAuth token health, …). One size and
 * shape for every status chip so they read as a uniform row. Callers supply the
 * colour pair via `className`, and it must be a TOKEN pair rather than a literal
 * Tailwind shade (e.g. "bg-warning/15 text-warning-strong", not
 * "bg-amber-100 text-amber-700"): a literal follows no palette, so the chip
 * keeps its old hue when the visual direction changes. On a tint, pair with the
 * `-strong` variant — the `-foreground` half is for solid fills and is white in
 * every light palette.
 *
 * forwardRef + prop spread so it can serve as a Radix `PopoverTrigger asChild`
 * child (the Codex reset-credit chip), which clones the element to inject a ref
 * and event handlers.
 */
export const StatusChip = forwardRef<
	HTMLSpanElement,
	ComponentPropsWithoutRef<"span">
>(function StatusChip({ className, ...props }, ref) {
	return (
		<span
			ref={ref}
			className={cn(
				"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
				className,
			)}
			{...props}
		/>
	);
});
