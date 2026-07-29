// Path geometry for the tiny inline sparklines in the System Health strip.
// Deliberately not recharts: `ResponsiveContainer` measures the DOM to size
// itself, so it renders nothing under this package's `renderToStaticMarkup`
// test style. Keeping the geometry a pure function means it can be unit-tested
// directly and the SVG stays a dumb, measurement-free wrapper.

/**
 * Build an SVG `d` attribute for a polyline through `values`, mapped into a
 * `width` × `height` viewBox. The first value sits at x=0, the last at
 * x=width; y is inverted so larger values render higher.
 *
 * Returns "" when there is nothing meaningful to draw (no values, or a single
 * point — a one-point "line" has no extent). Non-finite entries are dropped
 * before scaling, so a gap in the history can't poison the whole path with NaN.
 *
 * A flat series is the NORMAL case here, not an edge case: an idle proxy's RSS
 * barely moves, so every value can legitimately be identical. That would make
 * the value span zero and divide by zero, so a flat series is pinned to the
 * vertical midpoint instead.
 */
export function buildSparklinePath(
	values: readonly number[],
	width: number,
	height: number,
): string {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length < 2) return "";

	let min = finite[0];
	let max = finite[0];
	for (const v of finite) {
		if (v < min) min = v;
		if (v > max) max = v;
	}

	const span = max - min;
	const stepX = width / (finite.length - 1);

	return finite
		.map((v, i) => {
			const x = i * stepX;
			// span === 0 → flat series → midline. Otherwise invert so the max
			// value lands at y=0 (the top of the viewBox).
			const y = span === 0 ? height / 2 : height - ((v - min) / span) * height;
			return `${i === 0 ? "M" : "L"}${round(x)} ${round(y)}`;
		})
		.join(" ");
}

/** Trim coordinates to 2dp — full float precision only bloats the markup. */
function round(n: number): number {
	return Math.round(n * 100) / 100;
}
