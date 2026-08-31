import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the theme's CSS custom properties straight out of `styles/globals.css`.
 *
 * Design-time helper for the guards that assert things about the SHIPPED token
 * values — contrast ratios, and the separation between `--primary` and the
 * model palette. Both need the same parse, and two copies of a CSS parser in
 * two test files is how the two drift.
 *
 * Deliberately reads the stylesheet rather than a rendered page: the properties
 * that matter live in the token values, not in any component, and no component
 * has to mount for them to be wrong.
 */

/** One block's custom properties, keyed by property name. */
export type Tokens = Record<string, string>;

export type ColorScheme = "light" | "dark";

const CSS_PATH = join(import.meta.dir, "../../styles/globals.css");

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
	mode: ColorScheme,
): Tokens {
	const out: Tokens = {};
	for (const { selector, tokens } of blocks) {
		if (selector === ".dark" && mode !== "dark") continue;
		Object.assign(out, tokens);
	}
	return out;
}

let cachedBlocks: ReturnType<typeof parseBlocks> | null = null;

/** The token set one colour mode resolves to. The stylesheet is read once. */
export function readThemeTokens(mode: ColorScheme): Tokens {
	if (cachedBlocks === null) {
		cachedBlocks = parseBlocks(readFileSync(CSS_PATH, "utf8"));
	}
	return resolve(cachedBlocks, mode);
}
