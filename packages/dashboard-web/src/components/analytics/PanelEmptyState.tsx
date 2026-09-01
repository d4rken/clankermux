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
 */
const PanelEmptyState = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<"div">
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn(
			"flex min-h-40 items-center justify-center rounded-md border border-dashed px-section text-center text-sm text-muted-foreground",
			className,
		)}
		{...props}
	/>
));
PanelEmptyState.displayName = "PanelEmptyState";

export { PanelEmptyState };
