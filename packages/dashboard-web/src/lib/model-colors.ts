import { getModelShortName } from "@clankermux/core";
import { CHART_COLORS, MODEL_PALETTE } from "../constants";

/**
 * Model-based chart color palette, keyed by the UI short name
 * (`getModelShortName`) with a few legacy ids that predate the registry.
 *
 * Invariant: every id here has a GLOBALLY unique color — no two models share
 * one, regardless of family. Charts are not grouped per family: AnalyticsCharts
 * builds its series list from every distinct model in the time range, so Opus,
 * Sonnet and Mythos are plotted side by side and a cross-family repeat is just
 * as unreadable as a within-family one. The "all" range can also surface the
 * pre-registry legacy ids alongside current ones, so they need stable
 * assignments too. Colors come from MODEL_PALETTE (curated colorblind-safe
 * hues) rather than the semantic COLORS object, which has too few entries to go
 * around.
 *
 * Every registry model needs an explicit entry: the substring fallback below is
 * deliberately loose (`claude-opus-4-8` contains `claude-opus-4`), so a model
 * without an entry silently inherits an older model's color. Uniqueness and
 * perceptual separation are enforced by model-colors.test.ts.
 */
export const MODEL_COLORS: Record<string, string> = {
	"claude-3.5-sonnet": MODEL_PALETTE.rose,
	"claude-3.5-haiku": MODEL_PALETTE.pink,
	"claude-3-opus": MODEL_PALETTE.grey,
	"claude-opus-4": MODEL_PALETTE.blue,
	"claude-opus-4.1": MODEL_PALETTE.orange,
	"claude-opus-4.5": MODEL_PALETTE.green,
	"claude-opus-4.6": MODEL_PALETTE.magenta,
	"claude-opus-4.7": MODEL_PALETTE.skyBlue,
	"claude-opus-4.8": MODEL_PALETTE.yellow,
	"claude-opus-5": MODEL_PALETTE.red,
	"claude-sonnet-4": MODEL_PALETTE.mint,
	"claude-sonnet-4.5": MODEL_PALETTE.purple,
	"claude-sonnet-4.6": MODEL_PALETTE.pear,
	"claude-sonnet-5": MODEL_PALETTE.peach,
	"claude-haiku-4.5": MODEL_PALETTE.lightBlue,
	"claude-fable-5": MODEL_PALETTE.olive,
	"claude-mythos-5": MODEL_PALETTE.mauve,
};

/**
 * Resolve the chart color for a model id: explicit short-name entry, then
 * explicit raw-id entry, then a loose substring match (so unregistered or
 * third-party variants borrow their base model's color), then the index-based
 * chart color sequence.
 */
export function getModelColor(model: string, index: number): string {
	// Try to find color by short name first
	const shortName = getModelShortName(model);
	if (MODEL_COLORS[shortName]) return MODEL_COLORS[shortName];

	// Check for exact match
	if (MODEL_COLORS[model]) return MODEL_COLORS[model];

	// Check for partial matches
	for (const [key, color] of Object.entries(MODEL_COLORS)) {
		if (model.includes(key) || key.includes(model)) {
			return color;
		}
	}

	// Use chart colors array as fallback
	return CHART_COLORS[index % CHART_COLORS.length];
}
