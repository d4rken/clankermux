import type { OutlookTone } from "../../lib/pool-usage";

/**
 * How an outlook tone is painted, in one place for every quota surface.
 *
 * The Overview tinted its headline from a local three-way colour helper while
 * the Usage page used this table, so the two pages could paint the same pool
 * different colours even once they agreed on the verdict. One table, one
 * answer.
 */
export const TONE_CLASSES: Record<
	OutlookTone,
	{ chip: string; figure: string; progress: string }
> = {
	neutral: {
		chip: "bg-muted text-muted-foreground",
		figure: "text-muted-foreground",
		progress: "bg-muted-foreground/40",
	},
	success: {
		chip: "bg-success/15 text-success-strong",
		figure: "text-success-strong",
		progress: "bg-success",
	},
	warning: {
		chip: "bg-warning/15 text-warning-strong",
		figure: "text-warning-strong",
		progress: "bg-warning",
	},
	destructive: {
		chip: "bg-destructive/15 text-destructive-strong",
		figure: "text-destructive-strong",
		progress: "bg-destructive",
	},
};

/** Shorthand for the common case: tinting a headline figure. */
export const TONE_FIGURE_CLASS: Record<OutlookTone, string> = {
	neutral: TONE_CLASSES.neutral.figure,
	success: TONE_CLASSES.success.figure,
	warning: TONE_CLASSES.warning.figure,
	destructive: TONE_CLASSES.destructive.figure,
};
