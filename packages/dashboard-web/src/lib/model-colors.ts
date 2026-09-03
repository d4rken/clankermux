import { getModelShortName } from "@clankermux/core";
import { MODEL_PALETTE, MODEL_PALETTE_LIGHT } from "../constants";

/** Which chart ground the colour is being resolved for. */
export type ColorMode = "light" | "dark";

/**
 * Model-based chart colour assignment, keyed by the UI short name
 * (`getModelShortName`) with a few legacy ids that predate the registry.
 *
 * The value is a PALETTE KEY, not a hex string. A model's identity is the key;
 * the rendered value depends on the colour mode, because a hue that reads on
 * the near-black chart ground of the dark palettes is close to invisible on the
 * white card the light ones use, and vice versa. MODEL_PALETTE and
 * MODEL_PALETTE_LIGHT share their key set precisely so this indirection works.
 *
 * Invariant: every id here has a GLOBALLY unique key — no two models share one,
 * regardless of family. Charts are not grouped per family: AnalyticsCharts
 * builds its series list from every distinct model in the time range, so Opus,
 * Sonnet and Mythos are plotted side by side and a cross-family repeat is just
 * as unreadable as a within-family one. The "all" range can also surface the
 * pre-registry legacy ids alongside current ones, so they need stable
 * assignments too.
 *
 * Every registry model needs an explicit entry: the substring fallback below is
 * deliberately loose (`claude-opus-4-8` contains `claude-opus-4`), so a model
 * without an entry silently inherits an older model's colour. Uniqueness and
 * perceptual separation are enforced by model-colors.test.ts, in BOTH modes.
 */
export const MODEL_COLOR_KEYS: Record<string, keyof typeof MODEL_PALETTE> = {
	"claude-3.5-sonnet": "moss",
	"claude-3.5-haiku": "lilac",
	"claude-3-opus": "grey",
	"claude-opus-4": "blue",
	"claude-opus-4.1": "periwinkle",
	"claude-opus-4.5": "green",
	"claude-opus-4.6": "magenta",
	"claude-opus-4.7": "skyBlue",
	"claude-opus-4.8": "yellow",
	"claude-opus-5": "azure",
	"claude-sonnet-4": "mint",
	"claude-sonnet-4.5": "purple",
	"claude-sonnet-4.6": "indigo",
	"claude-sonnet-5": "emerald",
	"claude-haiku-4.5": "lightBlue",
	"claude-fable-5": "teal",
	"claude-mythos-5": "mauve",
	"claude-fable-5.1": "violet",
	"claude-mythos-5.1": "fuchsia",
	// Codex slugs, from MODEL_CONTEXT_WINDOWS. These need explicit entries for
	// the same reason the Claude ids do, and more urgently: the substring
	// fallback below would collapse `gpt-5.4-mini` onto `gpt-5.4`, and
	// `gpt-5.6-sol` alone is ~15% of live requests.
	"gpt-5.6-sol": "orchid",
	"gpt-5.6-terra": "fern",
	"gpt-5.6-luna": "gold",
	"gpt-5.5": "cornflower",
	"gpt-5.4": "tan",
	"gpt-5.4-mini": "sage",
	"gpt-5.3-codex-spark": "plum",
	// Promoted out of FALLBACK_HUES when GPT-6 Astra became routable
	// (2026-09-03): a registered model outranks an unknown-model bucket.
	"gpt-6-astra": "leaf",
};

/**
 * Hues held back for models with no explicit entry.
 *
 * Kept disjoint from every assigned key on purpose. The fallback used to index
 * CHART_COLORS, whose entries are hues that registered models already wear, so
 * an unrecognised model could render in Opus 4's blue — and on Live Activity,
 * whose legend lists a swatch per model, that surfaces as two rows with
 * identical colours and no way to tell which mark is which.
 *
 * Down to one bucket: `violet` and `fuchsia` were promoted to Fable/Mythos
 * 5.1 when the palette's 28 mutually-separable hues ran out, and `leaf` went
 * to GPT-6 Astra. Registered models win that trade — every model that actually
 * appears in traffic gets an explicit entry, and two colliding UNKNOWN ids is
 * a rarer, cheaper defect than two registered models sharing a hue. The next
 * registered model needs a new separable hue in both palettes, not this one.
 */
const FALLBACK_HUES: Array<keyof typeof MODEL_PALETTE> = ["amethyst"];

/** Resolve a palette key to its value for the given ground. */
export function paletteColor(
	key: keyof typeof MODEL_PALETTE,
	mode: ColorMode,
): string {
	return mode === "light" ? MODEL_PALETTE_LIGHT[key] : MODEL_PALETTE[key];
}

/**
 * FNV-1a over the model id. Any stable hash would do; this one is short, has no
 * dependency, and spreads short ASCII ids well enough for a small bucket pick.
 *
 * With a single fallback hue every unregistered model shares one colour. That
 * is the accepted floor, not an oversight: the alternative is more reserved
 * hues that no real model uses, taken out of the budget every REGISTERED model
 * competes for. Every model that actually appears in traffic gets an explicit
 * entry above, so this path is for genuinely unknown ids.
 */
function hashModelId(model: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < model.length; i++) {
		hash ^= model.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/**
 * Resolve the chart colour for a model id: explicit short-name entry, then
 * explicit raw-id entry, then a loose substring match (so unregistered or
 * third-party variants borrow their base model's colour), then a deterministic
 * hash of the id into the fallback sequence.
 *
 * The fallback hashes the ID rather than indexing by the model's POSITION in
 * whatever list is being drawn. Position is not a property of the model: it
 * changes as models enter and leave a time range, so an unregistered model
 * silently swapped colour between renders. On Live Activity — a window that
 * rolls continuously — that is a mark changing colour while you watch it.
 * `gpt-5.6-sol` was the live example, at ~15% of requests; it now has an
 * explicit entry, and this path is left for genuinely unrecognised ids.
 *
 * `mode` defaults to "dark" — the ground the dashboard used before light
 * palettes existed — so a call site that has not been threaded through the
 * colour mode keeps its previous behaviour instead of silently picking hues
 * tuned for the wrong ground.
 */
export function getModelColor(model: string, mode: ColorMode = "dark"): string {
	const key = getModelColorKey(model);
	if (key) return paletteColor(key, mode);

	return paletteColor(
		FALLBACK_HUES[hashModelId(model) % FALLBACK_HUES.length],
		mode,
	);
}

/** The palette key a model resolves to, or null if only the fallback applies. */
export function getModelColorKey(
	model: string,
): keyof typeof MODEL_PALETTE | null {
	const shortName = getModelShortName(model);
	if (MODEL_COLOR_KEYS[shortName]) return MODEL_COLOR_KEYS[shortName];

	if (MODEL_COLOR_KEYS[model]) return MODEL_COLOR_KEYS[model];

	for (const [candidate, key] of Object.entries(MODEL_COLOR_KEYS)) {
		if (model.includes(candidate) || candidate.includes(model)) return key;
	}

	return null;
}
