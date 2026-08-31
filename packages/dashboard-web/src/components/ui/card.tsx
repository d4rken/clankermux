import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Surface primitive.
 *
 * Interior padding is 1rem — the same value the spacing scale calls `group`,
 * so what separates panels and what lines them agree.
 *
 * It is spelled `p-4` rather than `p-group` deliberately. `CardContent` carries
 * `pt-0` so a header and a body do not double up their facing edges, and
 * tailwind-merge can only cancel that against a padding utility it recognises.
 * It does not recognise a custom scale key — `twMerge("p-group pt-0", "p-group")`
 * returns all three classes with `pt-0` still live — and it recognised the
 * previous custom `.surface-pad` class even less. The result was that every
 * card WITHOUT a header, which is every metric tile, rendered with zero top
 * padding and its content jammed against the border.
 *
 * There is deliberately no hover lift anywhere: geometry that moves under the
 * cursor is noise on a page whose job is reporting throttling state.
 */
const Card = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn(
			"rounded-lg border bg-card text-card-foreground shadow-card",
			className,
		)}
		{...props}
	/>
));
Card.displayName = "Card";

/**
 * Header block. Deliberately carries NO vertical spacing utility of its own.
 *
 * The gap that matters here is the one between a title and its description,
 * and a `space-y-*` on this element cannot own it: two thirds of the headers in
 * the app wrap the pair in a flex row so a range picker can sit beside them, and
 * `space-y` only reaches DIRECT children — so those headers rendered the
 * description flush against the title with no gap at all, while the unwrapped
 * ones got a different one. The spacing now lives on the title→description
 * adjacency itself (`@layer base` in globals.css, keyed on the `data-slot`
 * attributes below), which is true at any wrapper depth and identical
 * everywhere.
 */
const CardHeader = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div ref={ref} className={cn("flex flex-col p-4", className)} {...props} />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
	HTMLParagraphElement,
	React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
	<h3
		ref={ref}
		data-slot="title"
		// No `tracking-tight` here: Tailwind utilities outrank the base layer, so
		// it would pin letter-spacing and cancel the theme's own
		// --display-tracking, which .display-face applies.
		className={cn("display-face font-semibold leading-none", className)}
		{...props}
	/>
));
CardTitle.displayName = "CardTitle";

/**
 * Description line under a card title.
 *
 * `max-w-prose` (65ch) is on the paragraph itself, and it is the app's reading
 * measure rather than a local nicety: a full-width card on a 1600px screen was
 * setting these at 192 characters per line, which is roughly three times the
 * width at which the eye reliably finds the start of the next one. Every
 * description in the app is one sentence of explanation, so capping the
 * measure costs nothing and there is no case for a card whose prose runs the
 * full width of a panel.
 *
 * On the element, never on a wrapper: the title→description gap is a CSS
 * adjacency rule keyed on the two `data-slot` attributes (see globals.css and
 * card.test.tsx), and an element slipped between them would silently drop that
 * gap on every header in the app.
 */
const CardDescription = React.forwardRef<
	HTMLParagraphElement,
	React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
	<p
		ref={ref}
		data-slot="subtitle"
		className={cn("max-w-prose text-sm text-muted-foreground", className)}
		{...props}
	/>
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn("flex items-center p-4 pt-0", className)}
		{...props}
	/>
));
CardFooter.displayName = "CardFooter";

export { Card, CardContent, CardDescription, CardHeader, CardTitle };
