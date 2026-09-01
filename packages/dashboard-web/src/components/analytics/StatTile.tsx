import * as React from "react";

import { cn } from "../../lib/utils";
import { InsetPanel } from "../ui/inset-panel";

/**
 * The headline stat tile the cache panels render twelve of.
 *
 * It existed three times: byte-identical private copies in
 * `CacheKeepalivePanel` and `CacheEffectivenessPanel`, plus a third inlined in
 * the latter for the workload-normalized figure. Each copy carried the same
 * four defects in six lines — `bg-card` on a tile that already sits inside a
 * `Card`, so it has no surface step and is invisible but for its border; `p-3`
 * off the spacing scale; the micro-label hand-rolled as
 * `text-xs text-muted-foreground` rather than `.label-caps`; and the headline
 * number as `text-xl font-bold` in the sans, which is the one treatment
 * `.figure-lg` exists to replace.
 *
 * So: an `InsetPanel` (the nested-surface primitive, `bg-muted/30`), the house
 * label, and the house secondary figure.
 *
 * `p-row` is a deliberate override of the primitive's `px-row py-item`: a tile
 * is a square block of three stacked lines, not a row of definition pairs, and
 * it needs the same breathing room top and bottom that it has at the sides.
 *
 * `mt-0.5` on the sub-line stays numeric — 0.125rem maps to no step on the
 * spacing scale, and inventing one for a hairline offset would devalue it.
 */
interface StatTileProps
	extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
	label: string;
	value: string;
	/** Secondary line under the figure. `max-w-prose` because one of the twelve is a sentence. */
	sub?: string;
	valueClassName?: string;
}

const StatTile = React.forwardRef<HTMLDivElement, StatTileProps>(
	({ label, value, sub, valueClassName, className, ...props }, ref) => (
		<InsetPanel ref={ref} className={cn("p-row", className)} {...props}>
			<p className="label-caps">{label}</p>
			{/* cn(), not a template string: a call site tints this green or red, and
			    concatenation cannot cancel what the primitive already set. */}
			<p className={cn("figure-lg", valueClassName)}>{value}</p>
			{sub ? (
				<p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
					{sub}
				</p>
			) : null}
		</InsetPanel>
	),
);
StatTile.displayName = "StatTile";

export { StatTile };
