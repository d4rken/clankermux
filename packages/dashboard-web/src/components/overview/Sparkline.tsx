import { buildSparklinePath } from "../../lib/sparkline";

interface SparklineProps {
	values: readonly number[];
	/** Stroke color; defaults to the palette primary. */
	color?: string;
	/** Extra classes for sizing/visibility (e.g. `hidden sm:block`). */
	className?: string;
}

// Fixed viewBox units. The element is sized in CSS and the viewBox stretches to
// fill it, so nothing here depends on measuring the DOM.
const VIEW_W = 100;
const VIEW_H = 24;

/**
 * Tiny inline trend line for the System Health strip.
 *
 * `preserveAspectRatio="none"` is what lets the geometry be computed in fixed
 * viewBox units while the element flexes to whatever CSS size it's given;
 * `vector-effect="non-scaling-stroke"` then stops that same stretch from
 * squashing the stroke horizontally.
 *
 * Purely decorative — the adjacent numeric readout carries the value, so this
 * is `aria-hidden` rather than given a redundant label.
 */
export function Sparkline({
	values,
	color = "currentColor",
	className,
}: SparklineProps) {
	const d = buildSparklinePath(values, VIEW_W, VIEW_H);
	if (!d) return null;

	return (
		<svg
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			preserveAspectRatio="none"
			className={className}
			aria-hidden="true"
		>
			<path
				d={d}
				fill="none"
				stroke={color}
				strokeWidth={1.5}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
