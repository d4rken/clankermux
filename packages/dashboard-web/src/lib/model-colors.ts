import { getModelShortName } from "@clankermux/core";
import { CHART_COLORS, COLORS } from "../constants";

/**
 * Model-based chart color palette, keyed by the UI short name
 * (`getModelShortName`) with a few legacy ids that predate the registry.
 *
 * Invariant: no two models in the same family (opus / sonnet / haiku / fable)
 * may share a color — a chart typically plots several versions of one family
 * side by side, and identical colors make the lines indistinguishable. Repeats
 * ACROSS families are fine. Every registry model needs an explicit entry: the
 * substring fallback below is deliberately loose (`claude-opus-4-8` contains
 * `claude-opus-4`), so a model without an entry silently inherits an older
 * model's color. Enforced by model-colors.test.ts.
 */
export const MODEL_COLORS: Record<string, string> = {
	"claude-3.5-sonnet": COLORS.purple,
	"claude-3.5-haiku": COLORS.success,
	"claude-3-opus": COLORS.blue,
	"claude-opus-4": COLORS.pink,
	"claude-opus-4.1": COLORS.indigo,
	"claude-opus-4.5": COLORS.purple,
	"claude-opus-4.6": COLORS.cyan,
	"claude-opus-4.7": COLORS.success,
	"claude-opus-4.8": COLORS.warning,
	"claude-opus-5": COLORS.primary,
	"claude-sonnet-4": COLORS.cyan,
	"claude-sonnet-4.5": COLORS.blue,
	"claude-sonnet-4.6": COLORS.indigo,
	"claude-sonnet-5": COLORS.primary,
	"claude-haiku-4.5": COLORS.cyan,
	"claude-fable-5": COLORS.warning,
	"claude-mythos-5": COLORS.primary,
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
