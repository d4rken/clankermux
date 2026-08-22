import {
	BRAND_MARK_CANDIDATE_PATH,
	BRAND_MARK_CORE,
	BRAND_MARK_SELECTED_PATH,
	BRAND_MARK_STROKES,
} from "../brand-mark-geometry";

/**
 * The ClankerMux routing core: candidate lanes on both sides of a compact
 * switch, with the selected route carried by the heavier diagonal.
 *
 * `currentColor` lets the mark take the active palette's brand ink. Its shared
 * geometry also feeds the README generator; `logo.svg` remains the sole static
 * twin because browser chrome cannot import application code.
 */
export function BrandMark({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			role="img"
			aria-label="ClankerMux"
		>
			<path
				d={BRAND_MARK_CANDIDATE_PATH}
				strokeWidth={BRAND_MARK_STROKES.candidate}
			/>
			<rect {...BRAND_MARK_CORE} strokeWidth={BRAND_MARK_STROKES.core} />
			<path
				d={BRAND_MARK_SELECTED_PATH}
				strokeWidth={BRAND_MARK_STROKES.selected}
			/>
		</svg>
	);
}
