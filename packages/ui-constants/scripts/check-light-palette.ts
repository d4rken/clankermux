#!/usr/bin/env bun
/**
 * check-light-palette.ts — scratch verifier for a candidate light-ground model
 * palette.
 *
 * MODEL_PALETTE is documented as tuned for the dashboard's near-black chart
 * ground, with every entry above L* 45. A light palette needs the mirror
 * constraint (dark enough to read on white) while keeping the same pairwise
 * separation the dark set has, including under simulated colour-vision
 * deficiency.
 *
 * Run: bun packages/ui-constants/scripts/check-light-palette.ts
 * This is a design-time aid; model-colors.test.ts is what actually enforces the
 * result in CI.
 */

import { MODEL_PALETTE_LIGHT } from "../src/index";

type RGB = [number, number, number];

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

function hexToLab(hex: string): [number, number, number] {
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
	return `#${encode(rr)}${encode(gg)}${encode(bb)}`;
}

/** WCAG relative luminance, for contrast against the light chart ground. */
function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as RGB;
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hex: string, against: string): number {
	const a = luminance(hex) + 0.05;
	const b = luminance(against) + 0.05;
	return a > b ? a / b : b / a;
}

const MIN_DELTA_E = 15;
const MIN_CVD_DELTA_E = 7.9; // the dark palette's own floor — see the header
const MAX_LIGHTNESS = 66;
const MIN_CONTRAST = 3;
const CARD = "#ffffff";

const entries = Object.entries(MODEL_PALETTE_LIGHT);
const problems: string[] = [];

console.log(`\nlight model palette — ${entries.length} hues\n`);
for (const [name, hex] of entries) {
	const [lightness] = hexToLab(hex);
	const ratio = contrast(hex, CARD);
	const flag =
		lightness > MAX_LIGHTNESS || ratio < MIN_CONTRAST ? "  <-- FAIL" : "";
	if (flag) {
		problems.push(
			`${name} ${hex}: L* ${lightness.toFixed(1)}, contrast ${ratio.toFixed(2)}:1 on white`,
		);
	}
	console.log(
		`  ${name.padEnd(10)} ${hex}  L* ${lightness.toFixed(1).padStart(5)}  ${ratio.toFixed(2)}:1${flag}`,
	);
}

for (let i = 0; i < entries.length; i++) {
	for (let j = i + 1; j < entries.length; j++) {
		const [nameA, hexA] = entries[i];
		const [nameB, hexB] = entries[j];
		const normal = deltaE76(hexA, hexB);
		if (normal < MIN_DELTA_E) {
			problems.push(
				`${nameA} vs ${nameB}: dE ${normal.toFixed(1)} (min ${MIN_DELTA_E})`,
			);
		}
		for (const kind of ["prot", "deut"] as const) {
			const cvd = deltaE76(simulate(hexA, kind), simulate(hexB, kind));
			if (cvd < MIN_CVD_DELTA_E) {
				problems.push(
					`${nameA} vs ${nameB} under ${kind}anopia: dE ${cvd.toFixed(1)} (min ${MIN_CVD_DELTA_E})`,
				);
			}
		}
	}
}

if (problems.length === 0) {
	console.log("\nall constraints satisfied\n");
} else {
	console.log(`\n${problems.length} problem(s):`);
	for (const problem of problems) console.log(`  ${problem}`);
	console.log("");
	process.exit(1);
}
