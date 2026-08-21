import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Contrast guard for the theme tokens.
 *
 * Paper Terminal defines two complete token sets, one per colour mode.
 * Nothing else checks them: the components only name roles
 * (`text-warning-strong`, `bg-card`), so an amber too light for 12px text
 * produces no error anywhere — it just ships an unreadable status chip.
 *
 * This parses styles/globals.css directly rather than going through a rendered
 * page, because the failure lives in the token values, not in any component.
 *
 * The role split it enforces is the one that caused the original defect:
 *
 *   --warning        FILL hue. Pairs with --warning-foreground on a SOLID
 *                    background (`bg-warning text-warning-foreground`).
 *   --warning-strong TEXT hue, read against --card. What tinted chips
 *                    (`bg-warning/15 text-warning-strong`) and status text use.
 *
 * Using `-foreground` on a tint is what broke: on `bg-destructive/15` over a
 * white card, `--destructive-foreground` is white.
 */

const CSS_PATH = join(import.meta.dir, "../../styles/globals.css");

type Tokens = Record<string, string>;

/** The `:root` and `.dark` token blocks, in source order. */
function parseBlocks(css: string): Array<{ selector: string; tokens: Tokens }> {
	// Comments can contain braces and colons; strip them before matching.
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const blocks: Array<{ selector: string; tokens: Tokens }> = [];
	const blockRe = /^(:root|\.dark)\s*\{([\s\S]*?)^\}/gm;
	let match = blockRe.exec(stripped);
	while (match !== null) {
		const tokens: Tokens = {};
		const declRe = /(--[a-z-]+)\s*:\s*([^;]+);/g;
		let decl = declRe.exec(match[2]);
		while (decl !== null) {
			tokens[decl[1]] = decl[2].replace(/\s+/g, " ").trim();
			decl = declRe.exec(match[2]);
		}
		blocks.push({ selector: match[1], tokens });
		match = blockRe.exec(stripped);
	}
	return blocks;
}

/**
 * Resolve the token set a browser would compute for one colour mode.
 *
 * `:root` and `.dark` have equal specificity (0,1,0), so source order decides
 * and `.dark` wins by coming second. Dark deliberately redefines only colour —
 * radius, fonts and spacing are inherited from `:root` — so applying `:root`
 * first and layering `.dark` over it reproduces the cascade exactly.
 */
function resolve(
	blocks: ReturnType<typeof parseBlocks>,
	mode: "light" | "dark",
): Tokens {
	const out: Tokens = {};
	for (const { selector, tokens } of blocks) {
		if (selector === ".dark" && mode !== "dark") continue;
		Object.assign(out, tokens);
	}
	return out;
}

// ── colour maths ─────────────────────────────────────────────────────────────

type RGB = [number, number, number];

function srgbToLinear(channel: number): number {
	return channel <= 0.04045
		? channel / 12.92
		: ((channel + 0.055) / 1.055) ** 2.4;
}

function parseHex(value: string): RGB | null {
	const m = /^#([0-9a-f]{6})$/i.exec(value);
	if (!m) return null;
	const h = m[1];
	return [
		Number.parseInt(h.slice(0, 2), 16) / 255,
		Number.parseInt(h.slice(2, 4), 16) / 255,
		Number.parseInt(h.slice(4, 6), 16) / 255,
	];
}

function parseHsl(value: string): RGB | null {
	const m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/.exec(value);
	if (!m) return null;
	const h = Number(m[1]);
	const s = Number(m[2]) / 100;
	const l = Number(m[3]) / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) =>
		l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)];
}

/**
 * oklch() -> linear sRGB. Values are clamped into gamut the way a browser
 * would; every token in this file is in-gamut, so the clamp only guards
 * against float overshoot.
 */
function parseOklch(value: string): RGB | null {
	const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
	if (!m) return null;
	const L = Number(m[1]) / 100;
	const C = Number(m[2]);
	const hRad = (Number(m[3]) * Math.PI) / 180;
	const a = C * Math.cos(hRad);
	const b = C * Math.sin(hRad);

	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

	const clamp = (v: number) => Math.min(1, Math.max(0, v));
	return [
		clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
		clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
		clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
	];
}

/** Returns linear-light RGB, or null for a value this test cannot evaluate. */
function toLinearRgb(value: string): RGB | null {
	const hex = parseHex(value);
	if (hex) return hex.map(srgbToLinear) as RGB;
	const hsl = parseHsl(value);
	if (hsl) return hsl.map(srgbToLinear) as RGB;
	// oklch is already linear-light after the cube; the matrix output above is
	// linear sRGB, so no further transfer function.
	return parseOklch(value);
}

function luminance(value: string): number {
	const rgb = toLinearRgb(value);
	if (!rgb) throw new Error(`unparsable colour token: ${value}`);
	return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * The surface text actually lands on.
 *
 * A direction that separates panels with rules instead of boxes sets
 * `--card: transparent`, and transparent composites over the page background —
 * so that, not the literal keyword, is what a contrast ratio has to be measured
 * against.
 */
function surfaceOf(tokens: Tokens, name: string): string {
	const value = tokens[name];
	return value === "transparent" ? tokens["--background"] : value;
}

function contrast(a: string, b: string): number {
	const first = luminance(a) + 0.05;
	const second = luminance(b) + 0.05;
	return first > second ? first / second : second / first;
}

// ── the checks ───────────────────────────────────────────────────────────────

const MODES = ["light", "dark"] as const;

const blocks = parseBlocks(readFileSync(CSS_PATH, "utf8"));

/** WCAG AA for normal text. Everything read as prose has to clear this. */
const TEXT_MIN = 4.5;

/**
 * Solid semantic fills. Paper's own fills clear 4.5, but the floor stays at 3
 * because a fill is a badge background carrying a short word, not running
 * prose — and the pairing that matters most (`-foreground` on its own fill) is
 * checked here rather than assumed.
 */
const FILL_MIN = 3;

describe("theme token contrast", () => {
	it("parses a complete token set for both colour modes", () => {
		for (const mode of MODES) {
			{
				const tokens = resolve(blocks, mode);
				for (const required of [
					"--background",
					"--foreground",
					"--card",
					"--card-foreground",
					"--muted-foreground",
					"--primary",
					"--primary-foreground",
					"--success",
					"--success-foreground",
					"--success-strong",
					"--warning",
					"--warning-foreground",
					"--warning-strong",
					"--destructive",
					"--destructive-foreground",
					"--destructive-strong",
					"--info",
					"--surface-raised",
					"--border",
				]) {
					expect(`${mode} ${required}`).toBe(
						`${mode} ${tokens[required] ? required : "MISSING"}`,
					);
				}
			}
		}
	});

	it("keeps body and muted text readable on both surfaces", () => {
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = resolve(blocks, mode);
				const pairs: Array<[string, string, string]> = [
					["foreground on background", t["--foreground"], t["--background"]],
					[
						"card-foreground on card",
						t["--card-foreground"],
						surfaceOf(t, "--card"),
					],
					[
						"muted-foreground on card",
						t["--muted-foreground"],
						surfaceOf(t, "--card"),
					],
					// --surface-raised is what floating panels and SVG occluders sit
					// on, and it is a DIFFERENT colour from --card in any direction
					// that makes cards transparent — so it needs its own check.
					[
						"foreground on surface-raised",
						t["--foreground"],
						t["--surface-raised"],
					],
					[
						"muted-foreground on surface-raised",
						t["--muted-foreground"],
						t["--surface-raised"],
					],
					[
						"muted-foreground on background",
						t["--muted-foreground"],
						t["--background"],
					],
				];
				for (const [label, fg, bg] of pairs) {
					const ratio = contrast(fg, bg);
					if (ratio < TEXT_MIN) {
						failures.push(
							`${mode} ${label}: ${ratio.toFixed(2)}:1 (min ${TEXT_MIN})`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps every -strong semantic legible as text on a card", () => {
		// These are the tokens tinted chips and status text use. The defect this
		// guards: `bg-warning/15 text-warning` rendered a pale amber on a white
		// card at ~2.4:1.
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = resolve(blocks, mode);
				for (const role of ["success", "warning", "destructive", "info"]) {
					const token = role === "info" ? "--info" : `--${role}-strong`;
					const ratio = contrast(t[token], surfaceOf(t, "--card"));
					if (ratio < TEXT_MIN) {
						failures.push(
							`${mode} ${token} on --card: ${ratio.toFixed(2)}:1 (min ${TEXT_MIN})`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps solid fills legible against their own foreground", () => {
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = resolve(blocks, mode);
				const pairs: Array<[string, string, string]> = [
					["primary", t["--primary-foreground"], t["--primary"]],
					["success", t["--success-foreground"], t["--success"]],
					["warning", t["--warning-foreground"], t["--warning"]],
					["destructive", t["--destructive-foreground"], t["--destructive"]],
				];
				for (const [label, fg, bg] of pairs) {
					const ratio = contrast(fg, bg);
					const key = `${mode} ${label}`;
					if (ratio < FILL_MIN) {
						failures.push(
							`${key} fill: ${ratio.toFixed(2)}:1 (min ${FILL_MIN})`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps borders perceivable against their surface", () => {
		// Not a WCAG text rule — the three new directions lean on hairline borders
		// instead of shadows, so a border that vanishes into the card takes the
		// whole card boundary with it.
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = resolve(blocks, mode);
				const ratio = contrast(t["--border"], surfaceOf(t, "--card"));
				if (ratio < 1.15) {
					failures.push(`${mode} --border on --card: ${ratio.toFixed(2)}:1`);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
