/**
 * The ClankerMux mark: one thick stream in, three thin ones out.
 *
 * It replaces a 503x512 PNG of a dark rounded tile containing three `>_`
 * prompts, a hub and three robot grippers. The idea was right — many clients,
 * one front door, many backends — but it was drawn at app-icon detail, so at
 * the 24px it renders in the mobile header the grippers collapsed into noise,
 * and a fixed orange-on-black tile fights every light palette.
 *
 * Two properties make this version work where the PNG did not:
 *
 * - It carries the meaning in STROKE WEIGHT rather than line count. The one
 *   heavy inbound stroke against three light outbound ones survives being
 *   rasterised to 16px, where counting three separate inbound lines does not.
 * - It is `currentColor` throughout, so the mark takes the palette's own ink
 *   instead of pinning a brand hue that only suited one of them.
 *
 * The same two paths exist twice more, because neither place can import a React
 * component: `logo.svg` is the favicon, where no React tree exists to supply a
 * colour, and `scripts/build-readme-media.ts` draws it for the README. Change
 * the geometry here and it has to change in both.
 */
export function BrandMark({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			role="img"
			aria-label="ClankerMux"
		>
			{/* Inbound: one stream, deliberately heavier than everything after it. */}
			<path d="M1.5 12h9" strokeWidth="3.4" />
			{/* Outbound: three thin lanes fanning from the split point. */}
			<path
				d="M10.5 12c5 0 5-7.5 11-7.5M10.5 12h11M10.5 12c5 0 5 7.5 11 7.5"
				strokeWidth="1.5"
			/>
		</svg>
	);
}
