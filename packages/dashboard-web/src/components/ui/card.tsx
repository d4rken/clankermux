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

const CardHeader = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn("flex flex-col space-y-tight p-4", className)}
		{...props}
	/>
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
	HTMLParagraphElement,
	React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
	<h3
		ref={ref}
		// No `tracking-tight` here: Tailwind utilities outrank the base layer, so
		// it would pin letter-spacing and cancel the theme's own
		// --display-tracking, which .display-face applies.
		className={cn("display-face font-semibold leading-none", className)}
		{...props}
	/>
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
	HTMLParagraphElement,
	React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
	<p
		ref={ref}
		className={cn("text-sm text-muted-foreground", className)}
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
