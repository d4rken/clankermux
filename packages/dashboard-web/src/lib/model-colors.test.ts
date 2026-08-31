import { describe, expect, it } from "bun:test";
import { CLAUDE_MODEL_IDS } from "@clankermux/core";
import { STATUS_COLOR } from "../components/overview/LiveActivityLanes";
import {
	MODEL_PALETTE,
	MODEL_PALETTE_LIGHT,
	PINNED_MARK_COLORS,
} from "../constants";
import { readThemeTokens } from "./css-tokens";
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

// Codex slugs, mirroring MODEL_CONTEXT_WINDOWS. They plot on the same axes as
// the Claude models and appear in the same Live Activity legend, so they
// compete for colors and belong in every separation check below.
const CODEX_MODEL_IDS = [
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.3-codex-spark",
] as const;

const ALL_MODEL_IDS = [
	...Object.values(CLAUDE_MODEL_IDS),
	...LEGACY_MODEL_IDS,
	...CODEX_MODEL_IDS,
];

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

/**
 * Brettel/Viénot-style dichromat simulation, LMS via Hunt-Pointer-Estevez.
 *
 * The pairwise checks above run at normal vision, where amber and a yellow-green
 * are obviously different colors. Under protanopia and deuteranopia the
 * red-green axis collapses and both land on top of the error red — which is how
 * `olive` sat 0.6 dE from the pinned error red while looking nothing like it.
 */
function simulate(hex: string, kind: "prot" | "deut"): string {
	const h = hex.replace("#", "");
	const toLinear = (channel: number): number =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	const r = toLinear(Number.parseInt(h.slice(0, 2), 16) / 255);
	const g = toLinear(Number.parseInt(h.slice(2, 4), 16) / 255);
	const b = toLinear(Number.parseInt(h.slice(4, 6), 16) / 255);

	const l = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
	const m = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
	const s = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;

	let l2 = l;
	let m2 = m;
	if (kind === "prot") l2 = 1.05118294 * m - 0.05116099 * s;
	else m2 = 0.9513092 * l + 0.04866992 * s;

	const encode = (v: number): string => {
		const clamped = Math.min(1, Math.max(0, v));
		const srgb =
			clamped <= 0.0031308
				? clamped * 12.92
				: 1.055 * clamped ** (1 / 2.4) - 0.055;
		return Math.round(srgb * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${encode(5.47221206 * l2 - 4.6419601 * m2 + 0.16963708 * s)}${encode(
		-1.1252419 * l2 + 2.29317094 * m2 - 0.1678952 * s,
	)}${encode(0.02980165 * l2 - 0.19318073 * m2 + 1.16364789 * s)}`;
}

/** Lab hue angle in degrees, and chroma. */
function hueChroma(hex: string): { hue: number; chroma: number } {
	const [, a, b] = hexToLab(hex);
	const deg = (Math.atan2(b, a) * 180) / Math.PI;
	return { hue: deg < 0 ? deg + 360 : deg, chroma: Math.hypot(a, b) };
}

/** Shortest angular distance between two hue angles, in degrees. */
function hueArc(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
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
			ALL_MODEL_IDS.forEach((modelId) => {
				const color = getModelColor(modelId, mode);
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
			const colors = ALL_MODEL_IDS.map((modelId) =>
				getModelColor(modelId, mode),
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
				expect(palette.has(getModelColor(modelId, mode))).toBe(true);
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

	it("keeps every PALETTE ENTRY separable, not just the assigned ones", () => {
		// The per-model checks above only cover keys some model currently holds,
		// and only at normal vision. Both gaps matter: the fallback hues are
		// unassigned yet still get drawn, and dichromacy is where this palette is
		// tightest — `mint` vs `mauve` sits at 7.9 dE under simulated
		// protanopia/deuteranopia against a 7.9 floor. An edit that loosened
		// either would have shipped green.
		const MIN_DELTA_E = 15;
		const MIN_CVD_DELTA_E = 7.9;

		const tooClose: string[] = [];
		for (const mode of MODES) {
			const entries = Object.entries(paletteFor(mode));
			for (let i = 0; i < entries.length; i++) {
				for (let j = i + 1; j < entries.length; j++) {
					const [nameA, hexA] = entries[i];
					const [nameB, hexB] = entries[j];
					const normal = deltaE76(hexA, hexB);
					if (normal < MIN_DELTA_E) {
						tooClose.push(
							`[${mode}] ${nameA} vs ${nameB}: dE ${normal.toFixed(2)}`,
						);
					}
					for (const kind of ["prot", "deut"] as const) {
						const cvd = deltaE76(simulate(hexA, kind), simulate(hexB, kind));
						if (cvd < MIN_CVD_DELTA_E) {
							tooClose.push(
								`[${mode}] ${nameA} vs ${nameB} under ${kind}anopia: dE ${cvd.toFixed(2)}`,
							);
						}
					}
				}
			}
		}
		expect(tooClose).toEqual([]);
	});

	it("keeps a key's two grounds the same COLOR, not just the same name", () => {
		// The key is one identity rendered for two backgrounds. Nothing else
		// checks that: the palettes are separate literals, so a mistyped or
		// mispaired entry could make a model green in dark mode and violet in
		// light mode and every other test would still pass.
		//
		// Chroma-gated, because hue angle is meaningless for a near-neutral —
		// `grey` reads as 138 degrees apart between grounds while being grey in
		// both. The ceiling is deliberately loose: several original entries were
		// hand-darkened rather than walked down a hue ray and land ~22 degrees
		// off, which is still recognisably the same colour.
		const MAX_HUE_DRIFT = 25;
		const CHROMA_FLOOR = 15;

		const drifted: string[] = [];
		for (const name of Object.keys(MODEL_PALETTE) as Array<
			keyof typeof MODEL_PALETTE
		>) {
			const dark = hueChroma(MODEL_PALETTE[name]);
			const light = hueChroma(MODEL_PALETTE_LIGHT[name]);
			if (dark.chroma < CHROMA_FLOOR || light.chroma < CHROMA_FLOOR) continue;
			const drift = hueArc(dark.hue, light.hue);
			if (drift > MAX_HUE_DRIFT) {
				drifted.push(`${name}: ${drift.toFixed(1)}° apart between grounds`);
			}
		}
		expect(drifted).toEqual([]);
	});

	it("keeps every model color clear of the semantic status colors", () => {
		// Live Activity draws model-coloured request marks in the same plot as
		// amber "rate limited" and red "failed" marks. A model wearing either hue
		// reads as a warning at a glance no matter what its shape is, and the
		// busiest models are the ones that would flood the card with false alarm.
		// Shape is a redundant cue here, not a substitute: at a 2.5-7px radius the
		// fill colour resolves long before the outline does.
		const MIN_DELTA_E = 15;
		const MIN_CVD_DELTA_E = 7.9;
		const SEMANTIC = PINNED_MARK_COLORS;

		// The error red additionally reserves its whole HUE FAMILY. Distance
		// alone is not enough for it: the retired `red` (#CC3311) cleared 15 dE
		// while sitting 11 degrees away in hue, because it was merely darker —
		// and it was Claude Opus 5's colour, over half of all traffic. The
		// chroma gate keeps the rule from catching near-neutrals, which cannot
		// read as red however their hue angle computes.
		const MIN_HUE_ARC = 30;
		const HUE_ARC_CHROMA_FLOOR = 25;

		const conflicts: string[] = [];
		for (const mode of MODES) {
			for (const [name, hex] of Object.entries(paletteFor(mode))) {
				const { hue, chroma } = hueChroma(hex);
				for (const [role, target] of Object.entries(SEMANTIC)) {
					const normal = deltaE76(hex, target);
					const cvd = Math.min(
						deltaE76(simulate(hex, "prot"), simulate(target, "prot")),
						deltaE76(simulate(hex, "deut"), simulate(target, "deut")),
					);
					if (normal < MIN_DELTA_E || cvd < MIN_CVD_DELTA_E) {
						conflicts.push(
							`[${mode}] ${name} ${hex} vs ${role}: dE ${normal.toFixed(1)}, cvd ${cvd.toFixed(1)}`,
						);
					}
					if (role !== "error") continue;
					const arc = hueArc(hue, hueChroma(target).hue);
					if (arc < MIN_HUE_ARC && chroma >= HUE_ARC_CHROMA_FLOOR) {
						conflicts.push(
							`[${mode}] ${name} ${hex} is ${arc.toFixed(0)}° from the error hue at chroma ${chroma.toFixed(0)}`,
						);
					}
				}
			}
		}
		expect(conflicts).toEqual([]);
	});

	it("draws the status marks from the constant the clearance test measures", () => {
		// The check above is only worth anything if Live Activity draws the exact
		// hexes it measured. Routing STATUS_COLOR through `var(--warning)` would
		// leave every assertion above passing while the card drew the theme's
		// amber, which is 6.4 dE from `gold` and 2.5 dE from `tan` under
		// simulated dichromacy. One constant, asserted from both ends.
		expect(STATUS_COLOR.rate_limited).toBe(PINNED_MARK_COLORS.warning);
		expect(STATUS_COLOR.error).toBe(PINNED_MARK_COLORS.error);
	});

	it("keeps the theme's primary clear of every model color", () => {
		// --primary is drawn as a chart series in its own right (memory, request
		// volume, session scopes) on the same axes as model-coloured lines, so it
		// competes for identity exactly as the model hues do — but nothing gated
		// it until now. The pre-review light primary #155EEF measured 4.8 dE from
		// `azure` #025CF5, which is Claude Opus 5's light colour, and would have
		// shipped silently; #164EC9 sits 16.8 dE away.
		const MIN_DELTA_E = 15;
		const conflicts: string[] = [];
		for (const mode of MODES) {
			const primary = readThemeTokens(mode)["--primary"];
			for (const [name, hex] of Object.entries(paletteFor(mode))) {
				const distance = deltaE76(primary, hex);
				if (distance < MIN_DELTA_E) {
					conflicts.push(
						`[${mode}] --primary ${primary} vs ${name} ${hex}: dE ${distance.toFixed(1)}`,
					);
				}
			}
		}
		expect(conflicts).toEqual([]);
	});

	it("keeps Opus 4.5 through 5 off Opus 4's color", () => {
		const opus4 = getModelColor(CLAUDE_MODEL_IDS.OPUS_4);
		for (const modelId of [
			CLAUDE_MODEL_IDS.OPUS_4_5,
			CLAUDE_MODEL_IDS.OPUS_4_6,
			CLAUDE_MODEL_IDS.OPUS_4_7,
			CLAUDE_MODEL_IDS.OPUS_4_8,
			CLAUDE_MODEL_IDS.OPUS_5,
		]) {
			expect(getModelColor(modelId)).not.toBe(opus4);
		}
	});

	it("keeps Opus 5, Sonnet 5 and Mythos 5 mutually distinct", () => {
		// The reported defect: all three used to resolve to the same brand hue and
		// rendered as one indistinguishable line.
		const colors = [
			getModelColor(CLAUDE_MODEL_IDS.OPUS_5),
			getModelColor(CLAUDE_MODEL_IDS.SONNET_5),
			getModelColor(CLAUDE_MODEL_IDS.MYTHOS_5),
		];
		expect(new Set(colors).size).toBe(3);
	});

	it("keeps Sonnet 4.5 off the legacy claude-3.5-sonnet color", () => {
		expect(getModelColor(CLAUDE_MODEL_IDS.SONNET_4_5)).not.toBe(
			getModelColor("claude-3.5-sonnet"),
		);
	});

	it("never gives an unknown model a registered model's color", () => {
		// The fallback used to index CHART_COLORS, whose entries are hues that
		// registered models already wear. On Live Activity, which draws a legend
		// swatch per model, that shows up as two rows with the same colour and no
		// way to tell the marks apart.
		const assigned = new Set(
			ALL_MODEL_IDS.flatMap((modelId) =>
				MODES.map((mode) => getModelColor(modelId, mode)),
			),
		);
		for (const unknown of [
			"some-third-party-model",
			"llama-4-70b",
			"qwen3-max",
			"mistral-large",
		]) {
			for (const mode of MODES) {
				expect(`${unknown}:${assigned.has(getModelColor(unknown, mode))}`).toBe(
					`${unknown}:false`,
				);
			}
		}
	});

	it("keeps an unknown model on the same fallback hue in both grounds", () => {
		// The fallback hashes the model ID. Position in a series list is not a
		// property of the model — it moves as other series enter and leave a time
		// range — so an unregistered model used to change colour between renders,
		// which on the continuously-rolling Live Activity window is a mark
		// changing colour while you look at it.
		//
		// "Same KEY in both grounds" is the check: the two palettes hold different
		// hex for one identity, so agreeing on the key is what shows the choice
		// came from the id rather than from the call.
		for (const modelId of ["some-local-model", "llama-4-70b", "qwen3-max"]) {
			const darkKey = Object.entries(MODEL_PALETTE).find(
				([, hex]) => hex === getModelColor(modelId, "dark"),
			)?.[0];
			const lightKey = Object.entries(MODEL_PALETTE_LIGHT).find(
				([, hex]) => hex === getModelColor(modelId, "light"),
			)?.[0];
			expect(darkKey).toBeDefined();
			expect(`${modelId}:${lightKey}`).toBe(`${modelId}:${darkKey}`);
		}
	});

	it("still resolves an unregistered model via substring matching", () => {
		// A derived id that has no explicit entry borrows a base model's color
		// rather than falling through to the index-based sequence. The loop is
		// insertion-ordered and matches the first containing key, which is why
		// every registry model needs its own explicit entry.
		expect(getModelColor("claude-fable-5-preview")).toBe(
			getModelColor(CLAUDE_MODEL_IDS.FABLE_5),
		);
	});
});
