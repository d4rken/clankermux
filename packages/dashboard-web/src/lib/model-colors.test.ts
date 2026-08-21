import { describe, expect, it } from "bun:test";
import { CLAUDE_MODEL_IDS } from "@clankermux/core";
import {
	CHART_COLORS,
	CHART_COLORS_LIGHT,
	MODEL_PALETTE,
	MODEL_PALETTE_LIGHT,
} from "../constants";
import {
	type ColorMode,
	getModelColor,
	MODEL_COLOR_KEYS,
} from "./model-colors";

/**
 * Both grounds are exercised by every separation check below. A hue set that is
 * unique and separable on near-black says nothing about the same set on white:
 * the light palette is a different 17 hues resolved through the same keys, so
 * it needs its own pass or a collision there ships unnoticed.
 */
const MODES: ColorMode[] = ["dark", "light"];

/** The palette backing a mode, for the "drawn from the palette" assertions. */
const paletteFor = (mode: ColorMode) =>
	mode === "light" ? MODEL_PALETTE_LIGHT : MODEL_PALETTE;

// Legacy ids that predate the model registry. The "all" time range still plots
// them, so they compete for colors with the current models and belong in the
// uniqueness checks below.
const LEGACY_MODEL_IDS = [
	"claude-3-opus",
	"claude-3.5-sonnet",
	"claude-3.5-haiku",
] as const;

const ALL_MODEL_IDS = [...Object.values(CLAUDE_MODEL_IDS), ...LEGACY_MODEL_IDS];

/**
 * Convert an sRGB hex string to CIE L*a*b* (D65). Inlined rather than pulled in
 * as a dependency: it is ~25 lines and only this test needs it.
 */
function hexToLab(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	const toLinear = (channel: number): number =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	const r = toLinear(Number.parseInt(h.slice(0, 2), 16) / 255);
	const g = toLinear(Number.parseInt(h.slice(2, 4), 16) / 255);
	const b = toLinear(Number.parseInt(h.slice(4, 6), 16) / 255);

	// Linear sRGB -> XYZ, normalized by the D65 white point.
	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;

	const f = (t: number): number =>
		t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 color difference (Euclidean distance in L*a*b*). */
function deltaE76(a: string, b: string): number {
	const [l1, a1, b1] = hexToLab(a);
	const [l2, a2, b2] = hexToLab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** WCAG relative-luminance contrast ratio between two opaque colors. */
function contrastRatio(a: string, b: string): number {
	const luminance = (hex: string): number => {
		const h = hex.replace("#", "");
		const toLinear = (channel: number): number =>
			channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		const r = toLinear(Number.parseInt(h.slice(0, 2), 16) / 255);
		const g = toLinear(Number.parseInt(h.slice(2, 4), 16) / 255);
		const blue = toLinear(Number.parseInt(h.slice(4, 6), 16) / 255);
		return 0.2126 * r + 0.7152 * g + 0.0722 * blue;
	};
	const first = luminance(a) + 0.05;
	const second = luminance(b) + 0.05;
	return first > second ? first / second : second / first;
}

describe("getModelColor", () => {
	it("gives every model a globally unique color", () => {
		// AnalyticsCharts builds its series list from every distinct model in the
		// time range, not per family, so Opus/Sonnet/Mythos are plotted on the same
		// axes. A repeat anywhere — including across families — renders as two
		// identical lines.
		for (const mode of MODES) {
			const seen = new Map<string, string>();
			ALL_MODEL_IDS.forEach((modelId, index) => {
				const color = getModelColor(modelId, index, mode);
				expect(`${mode}:${seen.get(color) ?? modelId}`).toBe(
					`${mode}:${modelId}`,
				);
				seen.set(color, modelId);
			});
			expect(seen.size).toBe(ALL_MODEL_IDS.length);
		}
	});

	it("keeps every pair of model colors perceptually separable", () => {
		// Uniqueness alone would accept two near-identical hues. 15 dE is ~6x the
		// ~2.3 CIE76 just-noticeable-difference and comfortably below the curated
		// palette's actual tightest pair (~20.9), so it flags a genuinely
		// confusable addition without tripping on the existing assignments.
		const MIN_DELTA_E = 15;

		// Collected rather than asserted in the loop so a failure names the
		// offending model pair instead of just printing two numbers.
		const tooClose: string[] = [];
		for (const mode of MODES) {
			const colors = ALL_MODEL_IDS.map((modelId, index) =>
				getModelColor(modelId, index, mode),
			);
			for (let i = 0; i < colors.length; i++) {
				for (let j = i + 1; j < colors.length; j++) {
					const distance = deltaE76(colors[i], colors[j]);
					if (distance < MIN_DELTA_E) {
						tooClose.push(
							`[${mode}] ${ALL_MODEL_IDS[i]} vs ${ALL_MODEL_IDS[j]}: dE ${distance.toFixed(2)}`,
						);
					}
				}
			}
		}
		expect(tooClose).toEqual([]);
	});

	it("resolves every registered model to an explicit palette color", () => {
		// An explicit entry (matched via the model's short name) must win before
		// the loose substring fallback, which otherwise collapses e.g. every
		// claude-opus-4.x onto claude-opus-4's color.
		for (const mode of MODES) {
			const palette = new Set<string>(Object.values(paletteFor(mode)));
			for (const modelId of Object.values(CLAUDE_MODEL_IDS)) {
				expect(palette.has(getModelColor(modelId, 0, mode))).toBe(true);
			}
		}
	});

	it("assigns every model a key both palettes define", () => {
		// The two palettes share a key set on purpose: that is what lets a model
		// keep its identity across a light/dark switch while changing hex. A key
		// present in one and missing from the other would resolve to undefined in
		// exactly one mode.
		for (const key of Object.values(MODEL_COLOR_KEYS)) {
			expect(MODEL_PALETTE[key]).toBeDefined();
			expect(MODEL_PALETTE_LIGHT[key]).toBeDefined();
		}
		expect(Object.keys(MODEL_PALETTE_LIGHT).sort()).toEqual(
			Object.keys(MODEL_PALETTE).sort(),
		);
	});

	it("keeps every light-palette hue legible on a white card", () => {
		// The mirror of the dark palette's L* 45 floor. MODEL_PALETTE's own hues
		// include #99DDFF and #FFAABB, which sit under 1.5:1 on white — reusing
		// them on a light ground is the defect this palette exists to avoid.
		const faint: string[] = [];
		for (const [name, hex] of Object.entries(MODEL_PALETTE_LIGHT)) {
			const ratio = contrastRatio(hex, "#ffffff");
			if (ratio < 3) faint.push(`${name} ${hex}: ${ratio.toFixed(2)}:1`);
		}
		expect(faint).toEqual([]);
	});

	it("keeps Opus 4.5 through 5 off Opus 4's color", () => {
		const opus4 = getModelColor(CLAUDE_MODEL_IDS.OPUS_4, 0);
		for (const modelId of [
			CLAUDE_MODEL_IDS.OPUS_4_5,
			CLAUDE_MODEL_IDS.OPUS_4_6,
			CLAUDE_MODEL_IDS.OPUS_4_7,
			CLAUDE_MODEL_IDS.OPUS_4_8,
			CLAUDE_MODEL_IDS.OPUS_5,
		]) {
			expect(getModelColor(modelId, 0)).not.toBe(opus4);
		}
	});

	it("keeps Opus 5, Sonnet 5 and Mythos 5 mutually distinct", () => {
		// The reported defect: all three used to resolve to COLORS.primary and
		// rendered as one indistinguishable line.
		const colors = [
			getModelColor(CLAUDE_MODEL_IDS.OPUS_5, 0),
			getModelColor(CLAUDE_MODEL_IDS.SONNET_5, 1),
			getModelColor(CLAUDE_MODEL_IDS.MYTHOS_5, 2),
		];
		expect(new Set(colors).size).toBe(3);
	});

	it("keeps Sonnet 4.5 off the legacy claude-3.5-sonnet color", () => {
		expect(getModelColor(CLAUDE_MODEL_IDS.SONNET_4_5, 0)).not.toBe(
			getModelColor("claude-3.5-sonnet", 0),
		);
	});

	it("falls back to the chart color sequence for unknown models", () => {
		expect(getModelColor("some-third-party-model", 1)).toBe(CHART_COLORS[1]);
		expect(getModelColor("some-third-party-model", 1, "light")).toBe(
			CHART_COLORS_LIGHT[1],
		);
	});

	it("still resolves an unregistered model via substring matching", () => {
		// A derived id that has no explicit entry borrows a base model's color
		// rather than falling through to the index-based sequence. The loop is
		// insertion-ordered and matches the first containing key, which is why
		// every registry model needs its own explicit entry.
		expect(getModelColor("claude-fable-5-preview", 3)).toBe(
			getModelColor(CLAUDE_MODEL_IDS.FABLE_5, 0),
		);
	});
});
