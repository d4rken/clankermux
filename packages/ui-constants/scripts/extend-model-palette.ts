#!/usr/bin/env bun
/**
 * extend-model-palette.ts — design-time search for additional model hues.
 *
 * Two jobs, both driven by the SAME constraint set `model-colors.test.ts`
 * enforces, so a hue that passes here passes in CI:
 *
 *  1. Report which existing MODEL_PALETTE / MODEL_PALETTE_LIGHT entries sit too
 *     close to the semantic status colours (PINNED_MARK_COLORS). Those
 *     hues cannot identify a model on a surface where amber and red already mean
 *     "rate limited" and "failed" — Live Activity is such a surface.
 *  2. Search for replacement hues so every model can be assigned one that clears
 *     the semantic zone, with headroom for models added later.
 *
 * The search is greedy max-min: seed with the surviving hues, then repeatedly
 * take the in-gamut candidate whose smallest distance to everything already
 * chosen is largest. That maximises the tightest pair rather than the average,
 * which is the property that actually decides whether two series are tellable
 * apart.
 *
 * Modes:
 *   [count]                 feasibility only — reports how many hues each ground
 *                           can supply, searching the two INDEPENDENTLY. Use it
 *                           to answer "is N reachable at all"; its per-ground
 *                           picks are not a palette, because nothing ties a
 *                           dark hue to the light hue that shares its key.
 *   [count] --emit          the real generator. Searches both grounds TOGETHER
 *                           and prints paste-ready palette objects.
 *   --check "#hex,#hex"     full diagnostics for specific candidates.
 *   [count] key1,key2       treat those keys as retired for this run.
 *
 * Run: bun packages/ui-constants/scripts/extend-model-palette.ts 16 --emit
 */

import {
	MODEL_PALETTE,
	MODEL_PALETTE_LIGHT,
	PINNED_MARK_COLORS,
} from "../src/index";

type RGB = [number, number, number];
type Lab = [number, number, number];

function hexToRgb(hex: string): RGB {
	const h = hex.replace("#", "");
	return [
		Number.parseInt(h.slice(0, 2), 16),
		Number.parseInt(h.slice(2, 4), 16),
		Number.parseInt(h.slice(4, 6), 16),
	];
}

function toLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
	const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return c * 255;
}

function hexToLab(hex: string): Lab {
	const [r8, g8, b8] = hexToRgb(hex);
	const r = toLinear(r8);
	const g = toLinear(g8);
	const b = toLinear(b8);
	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
	const f = (t: number): number =>
		t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
	return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * Lab -> sRGB hex, or null when the colour falls outside the sRGB gamut.
 *
 * Out-of-gamut is REJECTED rather than clamped: clamping silently moves the
 * candidate somewhere else in Lab, so the separation the search just verified
 * would not be the separation that ships.
 */
function labToHex(lab: Lab): string | null {
	const [l, a, bLab] = lab;
	const fy = (l + 16) / 116;
	const fx = fy + a / 500;
	const fz = fy - bLab / 200;
	const inv = (t: number): number =>
		t ** 3 > 216 / 24389 ? t ** 3 : (108 / 841) * (t - 4 / 29);
	const x = inv(fx) * 0.95047;
	const y = inv(fy);
	const z = inv(fz) * 1.08883;

	const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
	const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
	const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

	const channels = [r, g, b].map(fromLinear);
	if (channels.some((c) => c < -0.5 || c > 255.5)) return null;
	return `#${channels
		.map((c) =>
			Math.round(Math.min(255, Math.max(0, c)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

function deltaE76(a: string, b: string): number {
	const [l1, a1, b1] = hexToLab(a);
	const [l2, a2, b2] = hexToLab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Brettel/Viénot-style dichromat simulation, LMS via Hunt-Pointer-Estevez. */
function simulate(hex: string, kind: "prot" | "deut"): string {
	const [r8, g8, b8] = hexToRgb(hex);
	const r = toLinear(r8);
	const g = toLinear(g8);
	const b = toLinear(b8);
	const l = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
	const m = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
	const s = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;

	let l2 = l;
	let m2 = m;
	if (kind === "prot") l2 = 1.05118294 * m - 0.05116099 * s;
	else m2 = 0.9513092 * l + 0.04866992 * s;

	const rr = 5.47221206 * l2 - 4.6419601 * m2 + 0.16963708 * s;
	const gg = -1.1252419 * l2 + 2.29317094 * m2 - 0.1678952 * s;
	const bb = 0.02980165 * l2 - 0.19318073 * m2 + 1.16364789 * s;

	const encode = (v: number): string =>
		Math.round(
			Math.max(0, Math.min(255, fromLinear(Math.min(1, Math.max(0, v))))),
		)
			.toString(16)
			.padStart(2, "0");
	return `#${encode(rr)}${encode(gg)}${encode(bb)}`;
}

function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hex: string, against: string): number {
	const a = luminance(hex) + 0.05;
	const b = luminance(against) + 0.05;
	return a > b ? a / b : b / a;
}

/** Smallest separation between two hues across normal and dichromat vision. */
function separation(a: string, b: string): { normal: number; cvd: number } {
	return {
		normal: deltaE76(a, b),
		cvd: Math.min(
			deltaE76(simulate(a, "prot"), simulate(b, "prot")),
			deltaE76(simulate(a, "deut"), simulate(b, "deut")),
		),
	};
}

// Thresholds are model-colors.test.ts's, not new ones: 15 dE at normal vision,
// and the dark palette's own 7.9 floor under simulated dichromacy.
const MIN_DELTA_E = 15;
const MIN_CVD_DELTA_E = 7.9;

/** The status colours a model hue must never be mistaken for. */
const SEMANTIC = PINNED_MARK_COLORS;

/**
 * Hues from the same published qualitative sets the palette already draws on
 * (Paul Tol's bright / high-contrast / vibrant / muted / light schemes and
 * Okabe-Ito), minus the ones MODEL_PALETTE already uses.
 *
 * Preferred over the Lab sweep, and kept verbatim rather than nudged, because
 * their separation was designed as a set and a hand-tweaked entry is no longer
 * covered by that work. They do not go far, though: most of MODEL_PALETTE now
 * comes from the sweep, because these sets cluster too tightly to yield 28
 * mutually separable hues.
 */
const CURATED_POOL = [
	"#4477AA", // Tol bright blue
	"#CCBB44", // Tol bright yellow
	"#66CCEE", // Tol bright cyan
	"#AA3377", // Tol bright purple
	"#BBBBBB", // Tol bright grey
	"#004488", // Tol high-contrast blue
	"#DDAA33", // Tol high-contrast yellow
	"#BB5566", // Tol high-contrast red
	"#EE7733", // Tol vibrant orange
	"#33BBEE", // Tol vibrant cyan
	"#009988", // Tol vibrant teal
	"#CC6677", // Tol muted rose
	"#332288", // Tol muted indigo
	"#DDCC77", // Tol muted sand
	"#117733", // Tol muted green
	"#88CCEE", // Tol muted cyan
	"#882255", // Tol muted wine
	"#44AA99", // Tol muted teal
	"#AAAA00", // Tol light olive
	"#56B4E9", // Okabe-Ito sky blue
	"#009E73", // Okabe-Ito bluish green
	"#F0E442", // Okabe-Ito yellow
	"#0072B2", // Okabe-Ito blue
	"#D55E00", // Okabe-Ito vermillion
] as const;

interface ModeSpec {
	name: string;
	palette: Record<string, string>;
	/** Does this hex satisfy the mode's legibility constraint? */
	legible: (hex: string) => boolean;
	/** Lightness band the search samples for this ground. */
	lightness: [number, number];
	describe: (hex: string) => string;
}

const MODES: ModeSpec[] = [
	{
		name: "dark",
		palette: MODEL_PALETTE,
		// Above L* 45 so it reads on the near-black chart ground.
		legible: (hex) => hexToLab(hex)[0] >= 45,
		lightness: [46, 88],
		describe: (hex) => `L* ${hexToLab(hex)[0].toFixed(1).padStart(5)}`,
	},
	{
		name: "light",
		palette: MODEL_PALETTE_LIGHT,
		legible: (hex) => hexToLab(hex)[0] <= 66 && contrast(hex, "#ffffff") >= 3,
		lightness: [26, 66],
		describe: (hex) =>
			`L* ${hexToLab(hex)[0].toFixed(1).padStart(5)}  ${contrast(hex, "#ffffff").toFixed(2)}:1`,
	},
];

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

/**
 * How close in hue a model colour may sit to a status colour, and the chroma
 * above which that closeness starts to matter.
 *
 * Distance alone is not enough. `red` (#CC3311) clears 15 dE from the error red
 * because it is DARKER, not because it is a different colour — it is 11° away
 * in hue and reads as red to anyone glancing at a 3px dot. Claude Opus 5 held
 * that key while being over half of all traffic, so the card would have been a
 * field of red marks with "red means failed" written under it.
 *
 * The chroma floor is what stops this from over-rejecting: the light palette's
 * `grey` (#4C4343) sits 11° from the error hue but at chroma 9 it is a warm
 * neutral, not a red. Only a colour saturated enough to read as its hue can be
 * confused for one.
 */
const MIN_HUE_ARC = 30;
const HUE_ARC_CHROMA_FLOOR = 25;

/**
 * The hue-arc rule applies to ERROR only, not to warning.
 *
 * Both status colours keep the numeric dE and dichromacy checks. The stricter
 * family rule is spent on red because red is the confusion that costs
 * something: a failure is drawn as an X sitting among filled circles of the
 * same size, so hue is what separates "this model" from "this failed". Amber is
 * a TRIANGLE, and 429s are about two requests a day here against fifteen
 * thousand successes — a yellow model mark is a shape apart from a rate limit
 * and vanishingly rarely next to one.
 *
 * Reserving both arcs would cost the whole warm half of the palette and leave
 * seventeen models to be told apart by greens, blues and purples alone, which
 * trades a real distinction for a mostly theoretical one.
 */
const HUE_ARC_RESERVED: Array<keyof typeof SEMANTIC> = ["error"];

/** Why a hue is unusable as a model identity colour, or null if it is fine. */
function semanticConflict(hex: string): string | null {
	const { hue, chroma } = hueChroma(hex);
	for (const [label, target] of Object.entries(SEMANTIC)) {
		const { normal, cvd } = separation(hex, target);
		if (normal < MIN_DELTA_E || cvd < MIN_CVD_DELTA_E) {
			return `${label} dE ${normal.toFixed(1)} / cvd ${cvd.toFixed(1)}`;
		}
		if (!HUE_ARC_RESERVED.includes(label as keyof typeof SEMANTIC)) continue;
		const arc = hueArc(hue, hueChroma(target).hue);
		if (arc < MIN_HUE_ARC && chroma >= HUE_ARC_CHROMA_FLOOR) {
			return `${label} hue arc ${arc.toFixed(0)}° at chroma ${chroma.toFixed(0)}`;
		}
	}
	return null;
}

/**
 * Keys whose value is being replaced in this mode. A key is only retired
 * outright when BOTH of its values conflict; when just one ground is affected
 * the key keeps its identity and only that ground's hex is refilled, which
 * leaves every model's colour assignment untouched.
 */
const RETIRED = new Set((process.argv[3] ?? "").split(",").filter(Boolean));

/**
 * Every in-gamut colour that is legible on `mode`'s ground and clear of the
 * status hues. Sampled in Lab rather than RGB so candidate density is uniform
 * in the space the separation is measured in.
 */
function gridForMode(mode: ModeSpec): string[] {
	const grid: string[] = [];
	for (let l = mode.lightness[0]; l <= mode.lightness[1]; l += 2) {
		for (let a = -100; a <= 100; a += 3) {
			for (let b = -100; b <= 100; b += 3) {
				const hex = labToHex([l, a, b]);
				if (!hex) continue;
				if (!mode.legible(hex)) continue;
				if (semanticConflict(hex)) continue;
				grid.push(hex);
			}
		}
	}
	return grid;
}

const WANTED = Number(process.argv[2] ?? 8);
const results: Record<string, Record<string, string>> = {};

/**
 * `--check <hex,...>` — full diagnostics for specific candidates instead of a
 * search. The greedy pass optimises distance from the EXISTING palette, which
 * is not the only thing that matters: a hue can clear every threshold and still
 * be the wrong choice because it reads as the same family as amber or red at a
 * glance. That judgement needs the numbers for a shortlist, not a ranking.
 */
const checkArg = process.argv.indexOf("--check");
if (checkArg !== -1) {
	const hexes = (process.argv[checkArg + 1] ?? "").split(",").filter(Boolean);
	for (const mode of MODES) {
		console.log(`\n=== ${mode.name} ground ===`);
		for (const hex of hexes) {
			const conflict = semanticConflict(hex);
			let tightest = Number.POSITIVE_INFINITY;
			let nearest = "";
			for (const [name, other] of Object.entries(mode.palette)) {
				// Only the key being replaced is skipped. An exact-duplicate value
				// under a DIFFERENT key must still be reported: skipping on
				// `other === hex` made re-checking an existing colour print PASS by
				// ignoring the very entry it collides with.
				if (RETIRED.has(name)) continue;
				const { normal, cvd } = separation(hex, other);
				const score = Math.min(normal, (cvd * MIN_DELTA_E) / MIN_CVD_DELTA_E);
				if (score < tightest) {
					tightest = score;
					nearest = `${name} (dE ${normal.toFixed(0)} / cvd ${cvd.toFixed(1)})`;
				}
			}
			const warn = separation(hex, SEMANTIC.warning);
			const err = separation(hex, SEMANTIC.error);
			const ok = !conflict && mode.legible(hex) && tightest >= MIN_DELTA_E;
			console.log(
				`  ${ok ? "PASS" : "FAIL"}  ${hex}  ${mode.describe(hex)}` +
					`  nearest ${nearest}` +
					`  | warning ${warn.normal.toFixed(0)}/${warn.cvd.toFixed(1)}` +
					`  error ${err.normal.toFixed(0)}/${err.cvd.toFixed(1)}` +
					(conflict ? `  <-- ${conflict}` : "") +
					(mode.legible(hex) ? "" : "  <-- illegible on this ground"),
			);
		}
	}
	process.exit(0);
}

for (const mode of MODES) {
	console.log(`\n=== ${mode.name} ground ===`);

	const safe: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [name, hex] of Object.entries(mode.palette)) {
		if (RETIRED.has(name)) continue;
		const conflict = semanticConflict(hex);
		if (conflict) dropped.push(`${name} ${hex} (${conflict})`);
		else safe[name] = hex;
	}

	console.log(`  survives semantic exclusion: ${Object.keys(safe).length}`);
	console.log(`  must be replaced: ${dropped.length}`);
	for (const line of dropped) console.log(`    - ${line}`);

	// Candidates come from the CURATED pool first. The palette's provenance is a
	// design commitment, not trivia: every existing entry is verbatim from an
	// established colourblind-safe qualitative set, and a hue pulled out of a
	// raw Lab sweep sits visibly outside that family even when it passes every
	// numeric check. Greedy max-min on an unconstrained grid makes this worse,
	// because the score is maximised at the gamut corners — it reaches for
	// electric violet and pure yellow every time.
	//
	// The Lab grid stays as the fallback for the light ground, where the pool
	// is thin: its hues must sit at or below L* 66, and most published
	// qualitative sets are tuned for a dark ground.
	// On the light ground the curated hues are used DARKENED, not verbatim —
	// the same construction MODEL_PALETTE_LIGHT already documents. Sweeping L*
	// down the same hue ray keeps the entry recognisably the curated colour
	// while meeting the 3:1-on-white floor that the originals miss.
	const pool =
		mode.name === "dark"
			? [...CURATED_POOL]
			: CURATED_POOL.flatMap((hex) => {
					const [, a, b] = hexToLab(hex);
					const ray: string[] = [];
					for (let l = 26; l <= 66; l += 1) {
						const scaled = labToHex([l, a, b]);
						if (scaled) ray.push(scaled);
					}
					return ray;
				});
	const inPalette = new Set(Object.values(mode.palette));
	const candidates: string[] = [];
	for (const hex of pool) {
		if (inPalette.has(hex)) continue;
		if (!mode.legible(hex)) continue;
		if (semanticConflict(hex)) continue;
		candidates.push(hex);
	}
	console.log(
		`  curated candidates clearing every constraint: ${candidates.length}`,
	);

	/**
	 * The Lab sweep, built lazily.
	 *
	 * Reached only once the curated pool can no longer supply a hue that clears
	 * pairwise separation — not merely when the pool STARTS smaller than the
	 * request. The raw pool is nearly always large enough on its own count; what
	 * exhausts it is the separation filter applied as picks accumulate, so
	 * sizing the decision off the initial count stopped the search early while
	 * viable colours existed.
	 */
	const gridCandidates = () => gridForMode(mode);
	let grownToGrid = false;

	// Greedy max-min against everything already in the set.
	const chosen: Record<string, string> = {};
	const selected = Object.values(safe);
	for (let n = 0; n < WANTED; n++) {
		let best: string | null = null;
		let bestScore = -1;
		for (const hex of candidates) {
			let worst = Number.POSITIVE_INFINITY;
			for (const other of selected) {
				const { normal, cvd } = separation(hex, other);
				if (normal < MIN_DELTA_E || cvd < MIN_CVD_DELTA_E) {
					worst = -1;
					break;
				}
				// Score on the CVD margin scaled onto the normal-vision floor, so a
				// candidate that is merely far apart for trichromats cannot outrank
				// one that stays separable for everyone.
				worst = Math.min(worst, normal, (cvd * MIN_DELTA_E) / MIN_CVD_DELTA_E);
			}
			if (worst > bestScore) {
				bestScore = worst;
				best = hex;
			}
		}
		if ((!best || bestScore < 0) && !grownToGrid) {
			// Curated pool spent. Widen to the sweep and retry this same slot, so
			// the curated hues are always preferred but never a hard ceiling.
			grownToGrid = true;
			candidates.push(...gridCandidates());
			console.log(`  … curated pool spent, widening to the Lab sweep`);
			n--;
			continue;
		}
		if (!best || bestScore < 0) {
			console.log(`  ! exhausted after ${n} new hues — no candidate left`);
			break;
		}
		chosen[`new${n + 1}`] = best;
		selected.push(best);
		const warn = separation(best, SEMANTIC.warning);
		const err = separation(best, SEMANTIC.error);
		console.log(
			`  + new${n + 1}  ${best}  ${mode.describe(best)}  tightest dE ${bestScore.toFixed(1)}` +
				`  | vs warning ${warn.normal.toFixed(0)}/${warn.cvd.toFixed(1)}` +
				`  vs error ${err.normal.toFixed(0)}/${err.cvd.toFixed(1)}`,
		);
	}

	results[mode.name] = { ...safe, ...chosen };
}

console.log("\n=== summary ===");
for (const mode of MODES) {
	console.log(
		`  ${mode.name}: ${Object.keys(results[mode.name]).length} usable hues`,
	);
}

/**
 * `--emit` — print the two palette objects ready to paste into src/index.ts.
 *
 * Transcribing 28 pairs of hex values by hand is how a palette that passed the
 * search ships with a typo that no test can attribute back to a mistyped digit.
 * Names for the new entries are derived from hue angle and lightness so they
 * describe the colour rather than its discovery order; the surviving entries
 * keep the names they already had, since those are the model-facing identity.
 *
 * The two grounds are searched TOGETHER, not independently. A key is one
 * identity with two renderings, so its light value has to be the same colour as
 * its dark value — found by walking down that hue's own ray until it clears the
 * light ground's contrast floor. Searching each ground separately and zipping
 * the results by position is what produces a key that is green in dark mode and
 * violet in light mode.
 */
if (process.argv.includes("--emit")) {
	const dark = MODES[0];
	const light = MODES[1];

	// Keys that survive in BOTH grounds keep both of their values.
	const keptDark: Record<string, string> = {};
	const keptLight: Record<string, string> = {};
	for (const [name, hex] of Object.entries(dark.palette)) {
		const lightHex = light.palette[name];
		if (semanticConflict(hex) || semanticConflict(lightHex)) continue;
		keptDark[name] = hex;
		keptLight[name] = lightHex;
	}

	const darkChosen = Object.values(keptDark);
	const lightChosen = Object.values(keptLight);

	/** Best-separated value for a hue ray on the light ground, or null. */
	const lightCounterpart = (darkHex: string): string | null => {
		const [, a, b] = hexToLab(darkHex);
		let best: string | null = null;
		let bestScore = -1;
		for (let l = 26; l <= 66; l += 0.5) {
			const hex = labToHex([l, a, b]);
			if (!hex || !light.legible(hex) || semanticConflict(hex)) continue;
			let worst = Number.POSITIVE_INFINITY;
			for (const other of lightChosen) {
				const { normal, cvd } = separation(hex, other);
				if (normal < MIN_DELTA_E || cvd < MIN_CVD_DELTA_E) {
					worst = -1;
					break;
				}
				worst = Math.min(worst, normal, (cvd * MIN_DELTA_E) / MIN_CVD_DELTA_E);
			}
			if (worst > bestScore) {
				bestScore = worst;
				best = hex;
			}
		}
		return bestScore < 0 ? null : best;
	};

	const pairs: Array<[string, string]> = [];
	const darkPool = [
		...CURATED_POOL.filter((h) => dark.legible(h) && !semanticConflict(h)),
	];
	let widened = false;
	while (pairs.length < WANTED) {
		let best: string | null = null;
		let bestPair: string | null = null;
		let bestScore = -1;
		for (const hex of darkPool) {
			let worst = Number.POSITIVE_INFINITY;
			for (const other of darkChosen) {
				const { normal, cvd } = separation(hex, other);
				if (normal < MIN_DELTA_E || cvd < MIN_CVD_DELTA_E) {
					worst = -1;
					break;
				}
				worst = Math.min(worst, normal, (cvd * MIN_DELTA_E) / MIN_CVD_DELTA_E);
			}
			if (worst <= bestScore) continue;
			// Only now pay for the light search — it is the expensive half, and a
			// candidate that cannot beat the incumbent on the dark ground can
			// never be chosen however good its counterpart is.
			const counterpart = lightCounterpart(hex);
			if (!counterpart) continue;
			bestScore = worst;
			best = hex;
			bestPair = counterpart;
		}
		if ((!best || !bestPair) && !widened) {
			widened = true;
			darkPool.push(...gridForMode(dark));
			continue;
		}
		if (!best || !bestPair) {
			console.log(`\n! only ${pairs.length} of ${WANTED} pairs were placeable`);
			break;
		}
		pairs.push([best, bestPair]);
		darkChosen.push(best);
		lightChosen.push(bestPair);
	}

	const NAMES: Array<[number, string]> = [
		[15, "red"],
		[45, "orange"],
		[75, "amber"],
		[100, "yellow"],
		[135, "lime"],
		[160, "green"],
		[180, "mint"],
		[200, "teal"],
		[230, "cyan"],
		[260, "blue"],
		[290, "indigo"],
		[315, "violet"],
		[340, "purple"],
		[360, "magenta"],
	];
	const nameFor = (hex: string): string => {
		const { hue, chroma } = hueChroma(hex);
		if (chroma < 15) return "grey";
		return NAMES.find(([limit]) => hue <= limit)?.[1] ?? "magenta";
	};

	// Names assigned once, from the DARK value, and reused for both grounds —
	// the key is the identity and must read the same in either palette.
	//
	// Seeded with the SURVIVING key names. Without that, a new yellow is also
	// called `yellow`, and since these are emitted into one object literal the
	// second entry silently overwrites the first — a duplicate key is not an
	// error in JS, it is a missing colour.
	const used = new Map<string, number>();
	for (const name of Object.keys(keptDark)) {
		const base = name.replace(/\d+$/, "");
		used.set(base, Math.max(used.get(base) ?? 0, 1));
	}
	const named = pairs.map(([darkHex, lightHex]) => {
		const base = nameFor(darkHex);
		const n = (used.get(base) ?? 0) + 1;
		used.set(base, n);
		return [`${base}${n > 1 ? n : ""}`, darkHex, lightHex] as const;
	});

	console.log("\n--- MODEL_PALETTE (dark) ---");
	for (const [name, hex] of Object.entries(keptDark)) {
		console.log(`\t${name}: "${hex.toUpperCase()}",`);
	}
	for (const [name, darkHex] of named) {
		console.log(`\t${name}: "${darkHex.toUpperCase()}",`);
	}

	console.log("\n--- MODEL_PALETTE_LIGHT ---");
	for (const [name, hex] of Object.entries(keptLight)) {
		console.log(`\t${name}: "${hex.toUpperCase()}",`);
	}
	for (const [name, , lightHex] of named) {
		const [lightness] = hexToLab(lightHex);
		console.log(
			`\t${name}: "${lightHex.toUpperCase()}", // L* ${lightness.toFixed(0)} · ${contrast(lightHex, "#ffffff").toFixed(1)}:1`,
		);
	}
	console.log(
		`\n  ${Object.keys(keptDark).length} kept + ${named.length} new = ${Object.keys(keptDark).length + named.length} keys`,
	);
}
