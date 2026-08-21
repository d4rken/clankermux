import * as React from "react";

import { cn } from "../../lib/utils";

const Card = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn(
			// shadow-card is a per-palette token: `classic` keeps a 1px lift, the
			// three directions set `none` and let the border do the separating.
			// There is deliberately no hover lift — geometry that moves under the
			// cursor is noise on a page reporting throttling state.
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
		className={cn("flex flex-col space-y-1.5 p-6", className)}
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
		// display-face pulls the palette's display family, tracking and casing.
		// It is where Foundry's condensed uppercase and Paper's serif actually
		// show up; `classic` maps it back to the body stack, so it is a no-op
		// there and the baseline is unchanged.
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
	<div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
	<div
		ref={ref}
		className={cn("flex items-center p-6 pt-0", className)}
		{...props}
	/>
));
CardFooter.displayName = "CardFooter";

export { Card, CardContent, CardDescription, CardHeader, CardTitle };
