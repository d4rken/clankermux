import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BRAND_MARK_CANDIDATE_PATH,
	BRAND_MARK_CORE,
	BRAND_MARK_SELECTED_PATH,
	BRAND_MARK_STROKES,
} from "../packages/dashboard-web/src/brand-mark-geometry";
import { renderAll } from "./build-readme-media";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = renderAll();

/**
 * These two SVGs are the README's brand mark, and nothing in this repo can
 * render one to look at. That makes silent breakage the realistic failure: a
 * geometry change that puts the mark outside its own 24-unit box, or a stray
 * bit of CSS that GitHub's proxy strips, shows up only on a published page.
 * The checks below stand in for the eye that cannot see the output.
 */

/**
 * Every number read out of the markup goes through here. A missing or malformed
 * attribute yields NaN, and NaN fails every `>` and `<` comparison silently —
 * so an `x="NaN"` would sail through a bounds check that looks strict.
 */
function num(attrs: string, name: string): number {
	const raw = attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`attribute ${name}="${raw}" is not a finite number`);
	}
	return value;
}

/**
 * Every point a path visits, including bezier control points, in absolute
 * coordinates.
 *
 * A flat sweep of the numbers in a `d` attribute cannot do this: the mark uses
 * `h`, whose operand is a RELATIVE x offset and not a coordinate at all, so
 * reading the numbers as x/y pairs would bound the wrong values. Any command
 * this does not implement throws rather than being skipped — an unrecognised
 * command must fail the test, not quietly shrink what it checks.
 */
function pathPoints(d: string): Array<[number, number]> {
	const points: Array<[number, number]> = [];
	let x = 0;
	let y = 0;
	const tokens = d.match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? [];
	let i = 0;
	const next = () => {
		const value = Number(tokens[i++]);
		if (!Number.isFinite(value)) {
			throw new Error(`path operand "${tokens[i - 1]}" is not a finite number`);
		}
		return value;
	};
	while (i < tokens.length) {
		const command = tokens[i++];
		switch (command) {
			case "M":
			case "L":
				x = next();
				y = next();
				points.push([x, y]);
				break;
			case "l":
				x += next();
				y += next();
				points.push([x, y]);
				break;
			case "H":
				x = next();
				points.push([x, y]);
				break;
			case "h":
				x += next();
				points.push([x, y]);
				break;
			case "V":
				y = next();
				points.push([x, y]);
				break;
			case "v":
				y += next();
				points.push([x, y]);
				break;
			case "C": {
				const [x1, y1, x2, y2, ex, ey] = [
					next(),
					next(),
					next(),
					next(),
					next(),
					next(),
				];
				points.push([x1, y1], [x2, y2], [ex, ey]);
				x = ex;
				y = ey;
				break;
			}
			case "c": {
				// Control points AND the endpoint are relative to the current point;
				// only the endpoint advances it.
				const [dx1, dy1, dx2, dy2, dx, dy] = [
					next(),
					next(),
					next(),
					next(),
					next(),
					next(),
				];
				points.push([x + dx1, y + dy1], [x + dx2, y + dy2], [x + dx, y + dy]);
				x += dx;
				y += dy;
				break;
			}
			default:
				throw new Error(`unhandled path command "${command}" in "${d}"`);
		}
	}
	return points;
}

function viewBox(svg: string): { width: number; height: number } {
	const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
	if (!m) throw new Error("no viewBox");
	return { width: Number(m[1]), height: Number(m[2]) };
}

describe("README media", () => {
	it("emits a light and a dark logo, and nothing else", () => {
		// The four dashboard mockups this script used to draw are now real
		// captures from `scripts/capture-readme-screenshots.sh`; if one reappears
		// here, two pipelines are writing the same figures.
		const names = files.map((f) => f.name).sort();
		expect(names).toEqual(["logo-dark.svg", "logo-light.svg"]);
	});

	it("matches what is committed in docs/media", () => {
		// The files are committed rather than built on demand, because GitHub
		// renders the README straight from the repo. A stale commit means the
		// published page disagrees with this script.
		for (const f of files) {
			const onDisk = readFileSync(join(ROOT, "docs", "media", f.name), "utf8");
			expect(`${f.name}: up to date`).toBe(
				onDisk === f.svg ? `${f.name}: up to date` : `${f.name}: STALE`,
			);
		}
	});

	it("keeps the static favicon aligned with the shared routing-core geometry", () => {
		const favicon = readFileSync(
			join(ROOT, "packages", "dashboard-web", "src", "logo.svg"),
			"utf8",
		);
		const readmeLogo = files.find((f) => f.name === "logo-light.svg")?.svg ?? "";
		const copies = [favicon, readmeLogo];
		const coreGeometry = [
			`x="${BRAND_MARK_CORE.x}"`,
			`y="${BRAND_MARK_CORE.y}"`,
			`width="${BRAND_MARK_CORE.width}"`,
			`height="${BRAND_MARK_CORE.height}"`,
			`rx="${BRAND_MARK_CORE.rx}"`,
		];

		for (const svg of copies) {
			expect(svg).toContain(`d="${BRAND_MARK_CANDIDATE_PATH}"`);
			expect(svg).toContain(`stroke-width="${BRAND_MARK_STROKES.candidate}"`);
			expect(svg).toContain(`d="${BRAND_MARK_SELECTED_PATH}"`);
			expect(svg).toContain(`stroke-width="${BRAND_MARK_STROKES.selected}"`);
			expect(svg).toContain(`stroke-width="${BRAND_MARK_STROKES.core}"`);
			for (const attribute of coreGeometry) expect(svg).toContain(attribute);
		}
	});

	for (const f of files) {
		describe(f.name, () => {
			it("carries no CSS and fetches nothing", () => {
				// An <img>-referenced SVG renders in secure static mode and GitHub is
				// free to sanitise what it proxies. Presentation attributes survive
				// both; a <style> block, an inline style, or an external reference is
				// not guaranteed to.
				expect(f.svg).not.toContain("<style");
				expect(f.svg).not.toContain("@media");
				expect(f.svg).not.toContain("class=");
				expect(f.svg).not.toMatch(/\sstyle="/);
				expect(f.svg).not.toContain("<script");
				expect(f.svg).not.toContain("<image");
				expect(f.svg).not.toContain("xlink");
				expect(f.svg).not.toContain("url(");
				expect(f.svg).not.toContain("@font-face");
				// The namespace URI is declared, never fetched; nothing else may be a
				// URL at all.
				expect([...f.svg.matchAll(/https?:\/\/[^"\s]*/g)].map((m) => m[0])).toEqual([
					"http://www.w3.org/2000/svg",
				]);
			});

			it("keeps every shape inside the canvas", () => {
				const { width, height } = viewBox(f.svg);
				const inX = (v: number) => {
					expect(v).toBeGreaterThanOrEqual(-0.5);
					expect(v).toBeLessThanOrEqual(width + 0.5);
				};
				const inY = (v: number) => {
					expect(v).toBeGreaterThanOrEqual(-0.5);
					expect(v).toBeLessThanOrEqual(height + 0.5);
				};

				let rects = 0;
				for (const m of f.svg.matchAll(/<rect ([^>]*)\/>/g)) {
					rects++;
					inX(num(m[1], "x"));
					inX(num(m[1], "x") + num(m[1], "width"));
					inY(num(m[1], "y"));
					inY(num(m[1], "y") + num(m[1], "height"));
				}

				// The mark is two paths plus the core rect and nothing else, so the
				// path arm is the one that carries this check — counted separately
				// because a rect-only tally would let a broken path regex pass as a
				// file full of shapes.
				let paths = 0;
				for (const m of f.svg.matchAll(/<path d="([^"]*)"/g)) {
					paths++;
					const points = pathPoints(m[1]);
					expect(points.length).toBeGreaterThan(0);
					for (const [x, y] of points) {
						inX(x);
						inY(y);
					}
				}

				// Guards the guard: a regex that stops matching would otherwise turn
				// this whole test into a pass.
				expect({ rects: rects > 0, paths: paths > 0 }).toEqual({
					rects: true,
					paths: true,
				});
			});
		});
	}

	it("uses each palette's own ink, so the pair is not two copies", () => {
		const dark = files.find((f) => f.name === "logo-dark.svg")?.svg ?? "";
		const light = files.find((f) => f.name === "logo-light.svg")?.svg ?? "";
		expect(dark).toContain("#4fb8be");
		expect(dark).not.toContain("#0f6d74");
		expect(light).toContain("#0f6d74");
		expect(light).not.toContain("#4fb8be");
	});

	it("is referenced by the README through a closed <picture>, not a bare <img>", () => {
		// A bare <img> would pin one theme's mark onto both GitHub themes: the
		// light logo is near-invisible on a dark page. Matching the whole element
		// rather than the two paths separately is what makes this a structural
		// check — the substrings alone would also be satisfied by two unrelated
		// images, or by an unclosed tag.
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const blocks = [
			...readme.matchAll(
				/<picture><source media="\(prefers-color-scheme: dark\)" srcset="docs\/media\/logo-dark\.svg"><img src="docs\/media\/logo-light\.svg"([^>]*)><\/picture>/g,
			),
		];
		expect(blocks).toHaveLength(1);
		expect(existsSync(join(ROOT, "docs", "media", "logo-dark.svg"))).toBe(true);
		expect(existsSync(join(ROOT, "docs", "media", "logo-light.svg"))).toBe(true);

		// That <picture> accounts for both mentions of the mark: one srcset, one
		// src. A third would be a reference outside it.
		expect(readme.match(/docs\/media\/logo-/g) ?? []).toHaveLength(2);
	});

	it("references every captured screenshot as a light/dark pair with alt text", () => {
		// The captures come from `scripts/capture-readme-screenshots.sh`, which
		// nothing here can run — so this is the only check that the README and
		// docs/media agree at all. Without it a renamed route, a half-finished
		// capture run, or a dropped dark variant reaches a published page as a
		// broken image.
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const names = ["overview", "accounts", "limits", "analytics"];

		for (const name of names) {
			for (const theme of ["light", "dark"]) {
				const file = join(ROOT, "docs", "media", `${name}-${theme}.png`);
				expect(`${name}-${theme}.png: ${existsSync(file)}`).toBe(
					`${name}-${theme}.png: true`,
				);
			}

			const block = readme.match(
				new RegExp(
					`<picture><source media="\\(prefers-color-scheme: dark\\)" srcset="docs/media/${name}-dark\\.png"><img src="docs/media/${name}-light\\.png"([^>]*)></picture>`,
				),
			);
			expect(`${name}: referenced`).toBe(
				block ? `${name}: referenced` : `${name}: MISSING or malformed`,
			);
			// Non-empty alt, unlike the logo: these figures carry information a
			// screen-reader user cannot otherwise get.
			const alt = block?.[1].match(/\salt="([^"]*)"/)?.[1] ?? "";
			expect(`${name} alt length`).toBe(
				alt.length > 40 ? `${name} alt length` : `${name} alt too short: "${alt}"`,
			);
		}

		// No stray references to figures that no longer exist.
		const referenced = [
			...readme.matchAll(/docs\/media\/([a-z-]+)\.png/g),
		].map((m) => m[1]);
		const expected = names.flatMap((n) => [`${n}-light`, `${n}-dark`]);
		expect([...new Set(referenced)].sort()).toEqual(expected.sort());
	});

	it("gives the logo an alt attribute", () => {
		// Deliberately empty: it sits beside the project name in the heading, so
		// announcing it would just repeat the word "ClankerMux". Empty is a
		// decision a screen reader honours; a missing attribute makes it read the
		// filename instead, which is why presence is asserted separately.
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const tags = [
			...readme.matchAll(/<img src="docs\/media\/logo-[^"]+"[^>]*>/g),
		].map((m) => m[0]);
		expect(tags).toHaveLength(1);
		for (const tag of tags) {
			expect(tag).toMatch(/\salt="/);
			expect(tag.match(/alt="([^"]*)"/)?.[1]).toBe("");
		}
	});
});
