import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Surface primitive.
 *
 * Panel geometry comes from tokens rather than from literal utilities here, so
 * every panel in the app changes together:
 *
 *   --card-border  full border shorthand, `1px solid var(--border)`.
 *   --card-shadow  none. Paper separates panels with a hairline, not a lift.
 *   --card-pad     interior padding, and the app's main density lever.
 *
 * These are applied by `.surface-edge` / `.surface-pad` in the base layer
 * rather than by Tailwind arbitrary-value utilities: `border-(--x)` in v4 maps
 * to border-COLOR, which would silently drop the width half of the shorthand.
 * Base-layer rules also lose to utilities, so a caller passing `p-4` still
 * wins.
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
		className={cn("flex flex-col space-y-tight surface-pad", className)}
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
