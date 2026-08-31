import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
	// `ring-offset-background` is load-bearing, not decoration: Tailwind's
	// default --tw-ring-offset-color is #fff, so `ring-offset-2` alone draws a
	// white halo around a focused badge on a near-black ground.
	"inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary text-primary-foreground shadow-card hover:bg-primary/80",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive text-destructive-foreground shadow-card hover:bg-destructive/80",
				outline: "text-foreground",
				// Not white: white on the mid-green this variant used to fill with
				// was ~2.22:1, nowhere near the 4.5:1 minimum.
				// `--success-foreground` is the near-black/near-white partner that
				// ships with the fill, and theme-contrast.test.ts holds the pair
				// above 3:1 in both modes whatever the fill becomes.
				success:
					"border-transparent bg-success text-success-foreground shadow-card hover:bg-success/80",
				// Same story, worse: white on the amber this variant used to fill
				// with was ~1.91:1. `--warning-foreground` is its shipped partner.
				warning:
					"border-transparent bg-warning text-warning-foreground shadow-card hover:bg-warning/80",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

interface BadgeProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return (
		<div className={cn(badgeVariants({ variant }), className)} {...props} />
	);
}

export { Badge, badgeVariants };
