import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as React from "react";
import { cn } from "../../lib/utils";

const Progress = React.forwardRef<
	React.ElementRef<typeof ProgressPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
		indicatorClassName?: string;
	}
>(({ className, indicatorClassName, max = 100, value, ...props }, ref) => {
	const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
	const safeValue =
		typeof value === "number" && Number.isFinite(value)
			? Math.max(0, Math.min(safeMax, value))
			: null;
	const percentage = safeValue == null ? 0 : (safeValue / safeMax) * 100;

	return (
		<ProgressPrimitive.Root
			ref={ref}
			max={safeMax}
			value={safeValue}
			className={cn(
				"relative h-2 w-full overflow-hidden rounded-full bg-secondary",
				className,
			)}
			{...props}
		>
			<ProgressPrimitive.Indicator
				className={cn(
					"h-full w-full flex-1 bg-primary transition-all duration-700 ease-out",
					indicatorClassName,
				)}
				style={{ transform: `translateX(-${100 - percentage}%)` }}
			/>
		</ProgressPrimitive.Root>
	);
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
