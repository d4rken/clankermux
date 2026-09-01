import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * The "nothing to draw here" block inside an analytics panel body.
 *
 * One route carried four empty-state treatments: the dashed box in two
 * spellings (with and without `px-6 text-center`), centred text in a borderless
 * `h-48` box, and a hand-rolled CSS ring that existed nowhere else in the app.
 * This is the dashed box, in the roomier of its two spellings, on the spacing
 * scale.
 *
 * `min-h-40` and not a fixed height: the message is one or two sentences at the
 * panel's width, and a fixed box clips the longer ones on a narrow screen.
 *
 * NOT adopted by the three prose-only empty states in the quota panels. Those
 * panel bodies are themselves prose, so a dashed box there would be a box drawn
 * around a sentence.
 *
 * The `icon` and `action` slots exist for the two empty states outside
 * Analytics — the routing-chains one carries a call-to-action button, the
 * API-keys one a shield glyph. Passing NEITHER renders exactly what the seven
 * Analytics call sites render today: a single row-flex box with the message as
 * its only child (pinned by full-string equality in the test).
 */
interface PanelEmptyStateProps extends React.ComponentPropsWithoutRef<"div"> {
	/** Sits above the message, centred. */
	icon?: React.ReactNode;
	/** Sits below the message, centred — typically the panel's call to action. */
	action?: React.ReactNode;
}

const PanelEmptyState = React.forwardRef<HTMLDivElement, PanelEmptyStateProps>(
	({ className, icon, action, children, ...props }, ref) => {
		const hasSlot = icon != null || action != null;
		return (
			<div
				ref={ref}
				className={cn(
					"flex min-h-40 items-center justify-center rounded-md border border-dashed px-section text-center text-sm text-muted-foreground",
					hasSlot && "flex-col gap-row",
					className,
				)}
				{...props}
			>
				{icon ? <span className="flex shrink-0">{icon}</span> : null}
				{children}
				{action ? <span className="shrink-0">{action}</span> : null}
			</div>
		);
	},
);
PanelEmptyState.displayName = "PanelEmptyState";

export { PanelEmptyState };
