/**
 * Semantic tones, and the class each currently renders as.
 *
 * Several tests exist to hold a TONE rule — "a degraded pool warns", "a
 * low-confidence projection does not", "a pricing gap is amber and not red" —
 * and the only way a static-markup test can observe tone is the class the
 * element asks for. Naming the intent here keeps those assertions readable and
 * makes a palette rename one edit instead of a sweep across four test files.
 *
 * What this does NOT assert, in any test: that the class resolves to CSS. That
 * comes from `warning`/`destructive` being registered theme colors in
 * globals.css's `@theme inline` block.
 */
export const TONE = {
	/** Tinted panel ground for a warning state (status strips, status panels). */
	warningSurface: "bg-warning/10",
	/** The louder banner tint, for a warning that owns the top of a page. */
	warningBanner: "bg-warning/15",
	/** Tinted panel ground for a failure state. */
	destructiveSurface: "bg-destructive/10",
	/** Warning foreground — the contrast-safe pairing, not raw `--warning`. */
	warningText: "text-warning-strong",
	/** Failure foreground, same reasoning. */
	destructiveText: "text-destructive-strong",
	/**
	 * Any destructive ground at all, for the "this must NOT read as a failure"
	 * side of an assertion, where pinning one opacity would let a different red
	 * through.
	 */
	anyDestructiveSurface: "bg-destructive",
} as const;
