import { formatDurationDhm } from "../../lib/format-prediction";

interface RunwayHorizonStripProps {
	/**
	 * The projected run-out instant, or null when nothing is projected inside
	 * the horizon. Null draws an empty track — the honest picture of "checked
	 * this far, found nothing".
	 */
	exhaustsAtMs: number | null;
	/** The window the scan actually modelled, straight from the response. */
	horizonMs: number;
	/** The caller's ticking clock, so the marker slides between polls. */
	now: number;
	/**
	 * What sits under the marker: the key or account the run-out is attributed
	 * to. Null renders the horizon's own description instead.
	 */
	markerLabel?: string | null;
}

/**
 * The horizon the runway figure was measured against, drawn as a track with
 * the projected run-out marked on it.
 *
 * WHY it exists: the headline is frequently "∞", which on its own is a claim
 * with no stated scope — infinity compared to what? The scan checks a bounded
 * window (14 days today, but the response carries the real number so nothing
 * here hardcodes it), and `beyond-horizon` means only that it found no run-out
 * inside that window. The strip puts the bound on screen next to the glyph, so
 * the figure can be read rather than decoded from a caption.
 *
 * The fill is the SAFE stretch — from now to the run-out — not the consumed
 * one, matching the direction the figure counts in.
 */
export function RunwayHorizonStrip({
	exhaustsAtMs,
	horizonMs,
	now,
	markerLabel,
}: RunwayHorizonStripProps) {
	// A horizon that is absent or nonsensical cannot be drawn to scale, and a
	// strip drawn to a made-up scale is worse than no strip.
	if (!Number.isFinite(horizonMs) || horizonMs <= 0) return null;

	const remainingMs = exhaustsAtMs == null ? null : exhaustsAtMs - now;
	// Clamped, not discarded: a run-out that has slipped into the past renders
	// hard against the left edge, which is exactly where "out of quota now"
	// belongs. Past the right edge cannot happen for an outcome the scan
	// returned, but a stale marker mid-poll should sit at the end rather than
	// overflow the track.
	const fraction =
		remainingMs == null
			? null
			: Math.min(1, Math.max(0, remainingMs / horizonMs));

	const horizonLabel = formatDurationDhm(horizonMs);
	const description =
		fraction == null
			? `No run-out projected within ${horizonLabel}`
			: `Run-out projected ${formatDurationDhm(Math.max(0, remainingMs ?? 0))} into a ${horizonLabel} horizon`;

	return (
		<div className="mt-item">
			<div
				className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted/50"
				role="img"
				aria-label={description}
			>
				{fraction != null && (
					<>
						<div
							className="absolute inset-y-0 left-0 bg-muted-foreground/25"
							style={{ width: `${fraction * 100}%` }}
						/>
						{/* -translate-x-1/2 keeps the marker centred on its instant at
						    both extremes instead of hanging off the track. */}
						<div
							className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground/70"
							style={{ left: `${fraction * 100}%` }}
						/>
					</>
				)}
			</div>
			<div className="mt-tight flex items-baseline justify-between gap-item text-[10px] leading-tight text-muted-foreground/70">
				<span className="truncate" title={markerLabel ?? description}>
					{fraction == null ? "no run-out" : (markerLabel ?? "run-out")}
				</span>
				<span className="shrink-0 tabular-nums">{horizonLabel}</span>
			</div>
		</div>
	);
}
