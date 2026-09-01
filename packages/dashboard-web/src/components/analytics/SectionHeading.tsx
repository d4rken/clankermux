import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * The heading that opens a page SECTION — a band of cards under one title,
 * one level above `CardTitle`.
 *
 * The same title+description pair was hand-rolled three times across the
 * Analytics tabs, and one of the three omitted the `max-w-prose` the other two
 * carried, so a single page-section description ran the full panel width at
 * roughly three times the app's reading measure. None of the three carried
 * `display-face`, which `CardTitle` applies — so a section heading and the card
 * titles beneath it were set in two different families.
 *
 * The class list is spelled out rather than folded into a CSS component class
 * because `.display-face` sets ONLY font-family and tracking (globals.css):
 * naming it alone would drop these headings to body size and regular weight,
 * which is the opposite of what a section heading is for. Hence
 * `text-lg font-semibold` alongside it.
 *
 * The `data-slot` markers are load-bearing, not decoration: the title→subtitle
 * gap is a base-layer adjacency rule keyed on exactly this pair (see
 * globals.css and SectionHeading.test.tsx). Slip an element between them and
 * the gap silently disappears.
 */
interface SectionHeadingProps
	extends Omit<React.ComponentPropsWithoutRef<"div">, "title" | "children"> {
	title: React.ReactNode;
	/** Omitted renders no subtitle at all, rather than an empty paragraph. */
	description?: React.ReactNode;
}

const SectionHeading = React.forwardRef<HTMLDivElement, SectionHeadingProps>(
	({ title, description, className, ...props }, ref) => (
		<div ref={ref} className={cn(className)} {...props}>
			<h2 data-slot="title" className="display-face text-lg font-semibold">
				{title}
			</h2>
			{description ? (
				<p
					data-slot="subtitle"
					className="max-w-prose text-sm text-muted-foreground"
				>
					{description}
				</p>
			) : null}
		</div>
	),
);
SectionHeading.displayName = "SectionHeading";

export { SectionHeading };
