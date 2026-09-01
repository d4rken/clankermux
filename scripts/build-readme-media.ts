#!/usr/bin/env bun
/**
 * Generates the README's brand mark: `docs/media/logo-{light,dark}.svg`.
 *
 * This script used to draw four dashboard mockups as well. It no longer does —
 * the README's figures are real screenshots of a running instance, captured by
 * `scripts/capture-readme-screenshots.sh` against a seeded mock database. The
 * drawn mockups carried a second, diverging copy of the design tokens and were
 * already a palette behind, so they are gone; the logo remains, because it is a
 * genuine generated vector asset that nothing else produces.
 *
 * Two things worth knowing before editing:
 *
 *  - The two ink colours are `--primary` from
 *    `packages/dashboard-web/styles/globals.css`, duplicated rather than
 *    imported because that file is Tailwind source, not a module, and its value
 *    is `oklch()`, which SVG renderers do not reliably support. When the theme's
 *    primary moves, these move by hand — `bun run build:readme-media` then
 *    re-emits both files.
 *  - There is no `<style>` element and no CSS anywhere in the output, only
 *    presentation attributes. An SVG referenced by `<img>` renders in the
 *    browser's secure static mode, and GitHub serves README images through a
 *    proxy that is free to sanitise; attribute-only output cannot be broken by
 *    either. Light and dark are separate files chosen by `<picture>`, which is
 *    the one theme-switching mechanism GitHub documents.
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
}

const LIGHT: Palette = { primary: "#0f6d74" };
const DARK: Palette = { primary: "#4fb8be" };

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
 * Standalone mark for the README heading. Teal rather than the favicon's ink:
 * this one sits next to the project name, where it should read the way the app
 * renders it (`BrandMark` is `text-primary`), not the way a browser tab does.
 */
function logo(p: Palette): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" role="img">` +
		`<title>ClankerMux</title>` +
		brandMark(0, 0, 24, p.primary) +
		`</svg>\n`
	);
}

// ── Emit ────────────────────────────────────────────────────────────────────

/** Every file this script owns. Exported for the drift test. */
export function renderAll(): { name: string; svg: string }[] {
	return Object.entries(PALETTES).map(([mode, palette]) => ({
		name: `logo-${mode}.svg`,
		svg: logo(palette),
	}));
}

if (import.meta.main) {
	mkdirSync(OUT_DIR, { recursive: true });
	const files = renderAll();
	for (const f of files) writeFileSync(join(OUT_DIR, f.name), f.svg);
	console.log(`docs/media: wrote ${files.length} files`);
	for (const f of files) console.log(`  ${f.name}`);
}
