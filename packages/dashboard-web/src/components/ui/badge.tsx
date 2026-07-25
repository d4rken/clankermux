import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
	"inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
				secondary:
					"border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
				outline: "text-foreground",
				// White on green-500 is ~2.22:1 — nowhere near the 4.5:1 minimum.
				// `--success-foreground` is the near-black/near-white pairing that
				// ships with the token (~5.47:1 light, ~9.90:1 dark).
				success:
					"border-transparent bg-success text-success-foreground shadow hover:bg-success/80",
				// White on yellow-500 is ~1.91:1 — nowhere near the 4.5:1 minimum.
				// `--warning-foreground` is the near-black/near-white pairing that
				// ships with the token (~6.06:1 light, ~11.3:1 dark).
				warning:
					"border-transparent bg-warning text-warning-foreground shadow hover:bg-warning/80",
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
