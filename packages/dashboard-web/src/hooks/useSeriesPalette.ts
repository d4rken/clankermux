import { useMemo } from "react";
import {
	CHART_COLORS,
	CHART_COLORS_LIGHT,
	MODEL_PALETTE,
	MODEL_PALETTE_LIGHT,
} from "../constants";
import { useColorMode } from "../contexts/theme-context";
import { type ColorMode, getModelColor } from "../lib/model-colors";

/** Palette key set. Both grounds define the same keys with different values. */
export type HueName = keyof typeof MODEL_PALETTE;

export interface SeriesPalette {
	mode: ColorMode;
	/**
	 * Named qualitative hues, already resolved for the current ground. Typed as
	 * plain strings rather than `typeof MODEL_PALETTE`: that const object's
	 * members are literal types, so the light palette's values would not be
	 * assignable to them.
	 */
	hue: Record<HueName, string>;
	/** Index-addressed fallback sequence for series with no named assignment. */
	sequence: readonly string[];
	/** Colour for a model id, resolved for the current ground. */
	forModel: (model: string, index: number) => string;
}

/**
 * Chart colours for the ground currently being painted.
 *
 * Chart series cannot use the CSS token layer the rest of the UI uses: recharts
 * wants concrete values for `stroke`/`fill`, and the qualitative palette is a
 * curated 17-hue set rather than a handful of semantic roles. What it can do is
 * pick the right SET — the dark palette's hues are chosen to sit above L* 45 on
 * a near-black ground and several of them fall under 1.5:1 on a white card, so
 * a light palette needs its own values for the same keys.
 *
 * Everything drawing a chart should take its colours from here rather than
 * importing MODEL_PALETTE directly, or it silently keeps the dark set under the
 * light mode.
 */
export function useSeriesPalette(): SeriesPalette {
	const mode = useColorMode();

	return useMemo(
		() => ({
			mode,
			hue: mode === "light" ? MODEL_PALETTE_LIGHT : MODEL_PALETTE,
			sequence: mode === "light" ? CHART_COLORS_LIGHT : CHART_COLORS,
			forModel: (model: string, index: number) =>
				getModelColor(model, index, mode),
		}),
		[mode],
	);
}
