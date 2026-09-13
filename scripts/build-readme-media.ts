#!/usr/bin/env bun
/**
 * Generates the README's brand assets: `docs/media/{logo,banner}-{light,dark}.svg`.
 * The banner is what the README displays; the logo is the bare mark.
 *
 * Two constraints on the output:
 *
 *  - The mark's two inks are `--primary` from
 *    `packages/dashboard-web/styles/globals.css`, duplicated rather than
 *    imported because that file is Tailwind source, not a module, and its value
 *    is `oklch()`, which SVG renderers do not reliably support. When the theme's
 *    primary moves, these move by hand.
 *  - No `<style>` element and no CSS anywhere in the output, only presentation
 *    attributes. An SVG referenced by `<img>` renders in the browser's secure
 *    static mode, and GitHub serves README images through a proxy that is free
 *    to sanitise; attribute-only output cannot be broken by either. Light and
 *    dark are separate files chosen by `<picture>`, which is the one
 *    theme-switching mechanism GitHub documents.
 *
 * Usage: bun run build:readme-media
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BRAND_MARK_CANDIDATE_PATH,
	BRAND_MARK_CORE,
	BRAND_MARK_SELECTED_PATH,
	BRAND_MARK_STROKES,
} from "../packages/dashboard-web/src/brand-mark-geometry";

const OUT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"docs",
	"media",
);

// ── Palettes ────────────────────────────────────────────────────────────────

interface Palette {
	primary: string;
	/** Wordmark ink. Near-black on light, near-white on dark. */
	title: string;
	/** Slogan ink, one step down from the wordmark. */
	muted: string;
}

const LIGHT: Palette = {
	primary: "#0f6d74",
	title: "#0f172a",
	muted: "#475569",
};
const DARK: Palette = {
	primary: "#4fb8be",
	title: "#f1f5f9",
	muted: "#94a3b8",
};

const PALETTES = { light: LIGHT, dark: DARK } as const;

// ── SVG helpers ─────────────────────────────────────────────────────────────

function round(n: number): number {
	return Math.round(n * 10) / 10;
}

/** Candidate lanes passing through a core, with one selected route emphasized. */
function brandMark(x: number, y: number, size: number, ink: string): string {
	const s = size / 24;
	return (
		`<g transform="translate(${round(x)} ${round(y)}) scale(${round(s * 100) / 100})" ` +
		`fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">` +
		`<path d="${BRAND_MARK_CANDIDATE_PATH}" stroke-width="${BRAND_MARK_STROKES.candidate}"/>` +
		`<rect x="${BRAND_MARK_CORE.x}" y="${BRAND_MARK_CORE.y}" width="${BRAND_MARK_CORE.width}" height="${BRAND_MARK_CORE.height}" rx="${BRAND_MARK_CORE.rx}" stroke-width="${BRAND_MARK_STROKES.core}"/>` +
		`<path d="${BRAND_MARK_SELECTED_PATH}" stroke-width="${BRAND_MARK_STROKES.selected}"/>` +
		`</g>`
	);
}

// ── Logo ────────────────────────────────────────────────────────────────────

/**
 * The bare mark, at its own 24-unit size. Teal rather than the favicon's ink,
 * so it reads the way the app renders it (`BrandMark` is `text-primary`) rather
 * than the way a browser tab does. The README does not place this file; the
 * banner draws its own copy of the same geometry.
 */
function logo(p: Palette): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img">` +
		`<title>ClankerMux</title>` +
		brandMark(0, 0, 24, p.primary) +
		`</svg>\n`
	);
}

// ── Banner ──────────────────────────────────────────────────────────────────

/**
 * Font stack for the two text runs.
 *
 * An SVG behind an `<img>` cannot fetch a webfont, so these resolve against
 * whatever the reader's machine has, and the same string is a different width
 * on every platform. Hence the slack in the layout below rather than a fit:
 * `textLength` would pin the width, but it does so by respacing the glyphs
 * (and, with `lengthAdjust="spacingAndGlyphs"`, by stretching them). The widest
 * of 16 locally measured faces put the slogan at 281 of the 335px available.
 */
const FONT =
	"system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/** The two strings the banner draws. Exported so the README's alt text can be
 * asserted against them rather than restating them. */
export const NAME = "ClankerMux";
export const SLOGAN = "A self-hosted gateway for coding agents";

/**
 * Title banner: the mark, the name and the slogan on one row.
 *
 * Replaces an inline `<img>` beside a Markdown `#` heading, which GitHub
 * renders by baseline and cannot be talked out of — `align` is the only
 * attribute that survives its sanitiser and it aligns to the line box, not the
 * cap height, so the mark sat visibly low next to the text at every size.
 * Drawing both in one SVG makes the alignment ours rather than the renderer's.
 *
 * The 400x88 viewBox is the README's `width="400"`; everything scales with it.
 */
function banner(p: Palette): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 88" width="400" height="88" role="img" aria-label="${NAME}: ${SLOGAN.toLowerCase()}">` +
		`<title>${NAME}</title>` +
		brandMark(4, 20, 48, p.primary) +
		`<text x="64" y="45" font-family="${FONT}" font-size="27" font-weight="650" fill="${p.title}">${NAME}</text>` +
		`<text x="65" y="66" font-family="${FONT}" font-size="12" font-weight="400" fill="${p.muted}">${SLOGAN}</text>` +
		`</svg>\n`
	);
}

// ── Emit ────────────────────────────────────────────────────────────────────

/** Every file this script owns. Exported for the drift test. */
export function renderAll(): { name: string; svg: string }[] {
	return Object.entries(PALETTES).flatMap(([mode, palette]) => [
		{ name: `logo-${mode}.svg`, svg: logo(palette) },
		{ name: `banner-${mode}.svg`, svg: banner(palette) },
	]);
}

if (import.meta.main) {
	mkdirSync(OUT_DIR, { recursive: true });
	const files = renderAll();
	for (const f of files) writeFileSync(join(OUT_DIR, f.name), f.svg);
	console.log(`docs/media: wrote ${files.length} files`);
	for (const f of files) console.log(`  ${f.name}`);
}
