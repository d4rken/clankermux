import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * A bordered, muted block wrapping a small stat or definition group nested
 * INSIDE a Card.
 *
 * The idea was hand-rolled three times at three different opacities —
 * `bg-muted/20`, `/30` and `/50` — so one surface read as three, sometimes on
 * the same page. This settles on `/30`, the middle value, and drops the
 * `border-border/60` override one copy carried.
 *
 * Padding is on the named scale, which only resolves correctly because `cn()`
 * knows that scale (see lib/utils.ts): the two definition-list call sites put
 * their padding on the inner cells and cancel this one with `p-0`.
 */
interface InsetPanelProps extends React.ComponentPropsWithoutRef<"div"> {
	/**
	 * Element to render. Two call sites are definition lists whose direct
	 * children are `<dt>`/`<dd>` pairs — rendering those as a `<div>` would
	 * strip the pairs of their `dl` ancestor and the semantics with it.
	 */
	as?: React.ElementType;
}

const InsetPanel = React.forwardRef<HTMLDivElement, InsetPanelProps>(
	({ as: Comp = "div", className, ...props }, ref) => (
		<Comp
			ref={ref}
			className={cn("rounded-md border bg-muted/30 px-row py-item", className)}
			{...props}
		/>
	),
);
InsetPanel.displayName = "InsetPanel";

export { InsetPanel };
