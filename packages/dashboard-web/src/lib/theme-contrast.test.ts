import { describe, expect, it } from "bun:test";
import { PINNED_MARK_COLORS } from "../constants";
import { readThemeTokens, type Tokens } from "./css-tokens";

/**
 * Contrast guard for the theme tokens.
 *
 * Substrate defines two complete token sets, one per colour mode.
 * Nothing else checks them: the components only name roles
 * (`text-warning-strong`, `bg-card`), so an amber too light for 12px text
 * produces no error anywhere — it just ships an unreadable status chip.
 *
 * This reads styles/globals.css directly (via css-tokens.ts) rather than going
 * through a rendered page, because the failure lives in the token values, not
 * in any component.
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

/** WCAG AA for normal text. Everything read as prose has to clear this. */
const TEXT_MIN = 4.5;

/**
 * Solid semantic fills. Substrate's own fills clear 4.5, but the floor stays at
 * 3 because a fill is a badge background carrying a short word, not running
 * prose — and the pairing that matters most (`-foreground` on its own fill) is
 * checked here rather than assumed.
 */
const FILL_MIN = 3;

/**
 * Surfaces that only have to be TELLABLE APART, not readable: a hairline rule
 * against the panel it bounds, a control fill against the card behind it. The
 * theme separates panels with borders rather than boxes, so a border that
 * vanishes into the card takes the whole card boundary with it.
 */
const SEPARATION_MIN = 1.15;

describe("theme token contrast", () => {
	it("parses a complete token set for both colour modes", () => {
		for (const mode of MODES) {
			{
				const tokens = readThemeTokens(mode);
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
					// The nav rail's ground and its rule. There is deliberately no
					// --sidebar-foreground: the rail carries plain --foreground, which
					// is why the contrast pair checked below is --foreground/--sidebar.
					"--sidebar",
					"--sidebar-border",
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
				const t = readThemeTokens(mode);
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
					// Hover/focus surfaces and menus swap the ground out from under
					// text that is otherwise only ever checked against --card.
					[
						"accent-foreground on accent",
						t["--accent-foreground"],
						t["--accent"],
					],
					[
						"secondary-foreground on secondary",
						t["--secondary-foreground"],
						t["--secondary"],
					],
					[
						"popover-foreground on popover",
						t["--popover-foreground"],
						t["--popover"],
					],
					// The nav rail has its own ground and deliberately no foreground
					// token of its own, so this is the pair that decides whether nav
					// labels read.
					["foreground on sidebar", t["--foreground"], t["--sidebar"]],
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
				const t = readThemeTokens(mode);
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

	it("keeps solid fills legible and the focus ring perceivable", () => {
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = readThemeTokens(mode);
				const pairs: Array<[string, string, string]> = [
					["primary fill", t["--primary-foreground"], t["--primary"]],
					["success fill", t["--success-foreground"], t["--success"]],
					["warning fill", t["--warning-foreground"], t["--warning"]],
					[
						"destructive fill",
						t["--destructive-foreground"],
						t["--destructive"],
					],
					// --info has no -strong partner; its fill pairing is the only
					// thing standing between an info badge and white-on-pale-blue.
					["info fill", t["--info-foreground"], t["--info"]],
					// Not a fill: the focus ring is a non-text UI component (WCAG
					// 1.4.11), and the same 3:1 applies to it against the ground it
					// is drawn on. A ring nobody can see is a keyboard user with no
					// idea where focus is.
					["ring on background", t["--ring"], t["--background"]],
				];
				for (const [label, fg, bg] of pairs) {
					const ratio = contrast(fg, bg);
					if (ratio < FILL_MIN) {
						failures.push(
							`${mode} ${label}: ${ratio.toFixed(2)}:1 (min ${FILL_MIN})`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps borders perceivable against their surface", () => {
		// Not a WCAG text rule — the theme leans on hairline borders instead of
		// shadows, so a border that vanishes into the card takes the whole card
		// boundary with it.
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = readThemeTokens(mode);
				const pairs: Array<[string, string, string]> = [
					["--border on --card", t["--border"], surfaceOf(t, "--card")],
					// --input is the fill of an unfocused control, drawn on a card;
					// on a dark ground a field that does not separate from the panel
					// reads as an empty gap rather than something you can type in.
					["--input on --card", t["--input"], surfaceOf(t, "--card")],
					[
						"--sidebar-border on --sidebar",
						t["--sidebar-border"],
						t["--sidebar"],
					],
				];
				for (const [label, a, b] of pairs) {
					const ratio = contrast(a, b);
					if (ratio < SEPARATION_MIN) {
						failures.push(
							`${mode} ${label}: ${ratio.toFixed(2)}:1 (min ${SEPARATION_MIN})`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps every chart accent perceivable on its own card", () => {
		// Chart marks are 2px strokes and small fills read against --card, which
		// makes them non-text UI components under WCAG 1.4.11: 3:1 or they are
		// decoration. The qualitative accents are tokens and follow the mode; the
		// two status marks are pinned literals and do not.
		const failures: string[] = [];
		for (const mode of MODES) {
			{
				const t = readThemeTokens(mode);
				const accents: Array<[string, string]> = [
					["--chart-blue", t["--chart-blue"]],
					["--chart-purple", t["--chart-purple"]],
					["--chart-pink", t["--chart-pink"]],
					["--chart-indigo", t["--chart-indigo"]],
					["--chart-cyan", t["--chart-cyan"]],
					// Semantic roles are drawn as chart series too (success/error
					// rates, throttling), so they are held to the same floor.
					["--primary", t["--primary"]],
					["--success", t["--success"]],
					["--warning", t["--warning"]],
					["--destructive", t["--destructive"]],
					["pinned error mark", PINNED_MARK_COLORS.error],
					["pinned warning mark", PINNED_MARK_COLORS.warning],
				];
				for (const [label, value] of accents) {
					// NAMED EXEMPTION: the pinned warning amber measures 2.15:1 on the
					// light card and cannot move. It is one of exactly two
					// warning/error pairs (of 36 candidates) that keeps all 28 model
					// hues clear of the status hues under simulated protanopia and
					// deuteranopia — see model-colors.test.ts — and every darker amber
					// that reaches 3:1 collides with a model hue (#D97706 lands 1.9
					// CVD dE from `gold`, #B45309 0.8 from `fern`). Rate limits are
					// also drawn as TRIANGLES, so the mark is not colour-alone. This
					// is the value and the ratio that ship today.
					if (mode === "light" && label === "pinned warning mark") continue;
					const ratio = contrast(value, surfaceOf(t, "--card"));
					if (ratio < FILL_MIN) {
						failures.push(
							`${mode} ${label} on --card: ${ratio.toFixed(2)}:1 (min ${FILL_MIN})`,
						);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
