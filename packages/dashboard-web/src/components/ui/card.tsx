import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Surface primitive.
 *
 * Whether a panel reads as a BOX or as a RULE is a property of the visual
 * direction, not of the component, so the geometry comes from tokens:
 *
 *   --card-border   full border shorthand. `1px solid var(--border)` for the
 *                   box directions; `0` for the ones that separate with a rule
 *                   and whitespace instead.
 *   --card-top-rule top edge drawn on its own, so a borderless direction can
 *                   still mark where a panel begins the way a printed
 *                   statement does.
 *   --card-shadow   `classic` keeps a 1px lift; every other direction is flat.
 *   --card-pad      interior padding, which is the main density lever between
 *                   the airy directions and the dense ones.
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
			"rounded-lg bg-card text-card-foreground shadow-card surface-edge",
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
		className={cn("flex flex-col space-y-1.5 surface-pad", className)}
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
		// it would pin letter-spacing and cancel each palette's own tracking.
		// `classic` sets --display-tracking to the same -0.025em instead.
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
	<div ref={ref} className={cn("surface-pad pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn("flex items-center surface-pad pt-0", className)}
		{...props}
	/>
));
CardFooter.displayName = "CardFooter";

export { Card, CardContent, CardDescription, CardHeader, CardTitle };
