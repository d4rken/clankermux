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
import { CANVAS_WIDTH, renderAll, textWidth } from "./build-readme-media";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = renderAll();

/**
 * These SVGs are the README's illustrations, and nothing in this repo can
 * render one to look at. That makes silent breakage the realistic failure:
 * lengthen a mock account name or a chip label and the text runs off the canvas
 * or out of its own pill, and the only place it shows is a published page. The
 * checks below stand in for the eye that cannot see the output.
 */

interface Span {
	text: string;
	left: number;
	right: number;
	baseline: number;
}

/**
 * Every number read out of the markup goes through here. A missing or malformed
 * attribute yields NaN, and NaN fails every `>` and `<` comparison silently —
 * so an `x="NaN"` would sail through an overflow check that looks strict.
 */
function num(attrs: string, name: string): number {
	const raw = attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`attribute ${name}="${raw}" is not a finite number`);
	}
	return value;
}

function textSpans(svg: string): Span[] {
	const spans: Span[] = [];
	for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
		const [, attrs, body] = m;
		const attr = (name: string) =>
			attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
		const x = num(attrs, "x");
		const size = num(attrs, "font-size");
		const mono = (attr("font-family") ?? "").includes("Geist Mono");
		const anchor = attr("text-anchor") ?? "start";
		const w = textWidth(body, size, mono);
		const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
		spans.push({
			text: body,
			left,
			right: left + w,
			baseline: num(attrs, "y"),
		});
	}
	return spans;
}


function viewBoxHeight(svg: string): number {
	const m = svg.match(/viewBox="0 0 \d+ (\d+)"/);
	if (!m) throw new Error("no viewBox");
	return Number(m[1]);
}

describe("README media", () => {
	it("emits a light and a dark file for the logo and every view", () => {
		const names = files.map((f) => f.name).sort();
		expect(names).toEqual(
			[
				"accounts-dark.svg",
				"accounts-light.svg",
				"logo-dark.svg",
				"logo-light.svg",
				"overview-dark.svg",
				"overview-light.svg",
				"requests-dark.svg",
				"requests-light.svg",
				"usage-dark.svg",
				"usage-light.svg",
			].sort(),
		);
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
				expect([...f.svg.matchAll(/https?:\/\/[^"\s]*/g)].map((m) => m[0]))
					.toEqual(["http://www.w3.org/2000/svg"]);
			});

			it("never draws a pill narrower than the label on it", () => {
				// A global canvas bound cannot see this: a chip whose background is
				// too small for its own text sits well inside the page and still
				// clips. Lengthening a mock label is exactly what causes it.
				const boxes = f.pills;
				// Only two views draw chips; the logo and the two chart views draw
				// none, and asserting a minimum there would just be a false alarm.
				// Where chips ARE expected, the count is checked so that a pairing
				// that silently stops finding them cannot pass as clean.
				if (/^(accounts|requests)-/.test(f.name)) {
					expect(boxes.length).toBeGreaterThan(0);
				} else if (f.name.startsWith("logo-")) {
					expect(boxes).toHaveLength(0);
				}
				for (const b of boxes) {
					expect({ label: b.label, clipped: b.textLeft < b.boxLeft }).toEqual({
						label: b.label,
						clipped: false,
					});
					expect({ label: b.label, clipped: b.textRight > b.boxRight }).toEqual(
						{ label: b.label, clipped: false },
					);
				}
			});

			it("keeps every glyph inside its card, not merely inside the canvas", () => {
				const height = viewBoxHeight(f.svg);
				// The page gutter (24) plus a card's own padding (16). Text reaching
				// past this has escaped the panel it belongs to, which is the failure
				// that actually happens here — a lengthened chip label or account
				// name pushing a row wider than the card that draws it.
				const cardInterior = CANVAS_WIDTH - 24 - 16;
				for (const s of textSpans(f.svg)) {
					expect({
						text: s.text,
						overflowsRight: s.right > cardInterior,
					}).toEqual({ text: s.text, overflowsRight: false });
					expect({ text: s.text, overflowsLeft: s.left < 0 }).toEqual({
						text: s.text,
						overflowsLeft: false,
					});
					expect({
						text: s.text,
						belowCanvas: s.baseline > height - 4,
					}).toEqual({ text: s.text, belowCanvas: false });
				}
			});

			it("keeps every shape inside the canvas", () => {
				const height = viewBoxHeight(f.svg);
				const vb = f.svg.match(/viewBox="0 0 (\d+) \d+"/);
				const width = Number(vb?.[1]);
				const inX = (v: number) => {
					expect(v).toBeGreaterThanOrEqual(-0.5);
					expect(v).toBeLessThanOrEqual(width + 0.5);
				};
				const inY = (v: number) => {
					expect(v).toBeGreaterThanOrEqual(-0.5);
					expect(v).toBeLessThanOrEqual(height + 0.5);
				};

				let shapes = 0;
				for (const m of f.svg.matchAll(/<rect ([^>]*)\/>/g)) {
					shapes++;
					inX(num(m[1], "x"));
					inX(num(m[1], "x") + num(m[1], "width"));
					inY(num(m[1], "y"));
					inY(num(m[1], "y") + num(m[1], "height"));
				}
				for (const m of f.svg.matchAll(/<line ([^>]*)\/>/g)) {
					shapes++;
					inX(num(m[1], "x1"));
					inX(num(m[1], "x2"));
					inY(num(m[1], "y1"));
					inY(num(m[1], "y2"));
				}
				for (const m of f.svg.matchAll(/<circle ([^>]*)\/>/g)) {
					shapes++;
					inX(num(m[1], "cx"));
					inY(num(m[1], "cy"));
				}
				// Paths carry the brand mark, whose coordinates are absolute inside a
				// 24-unit box; the logo files contain nothing else, so without this
				// the shape check made no assertion about them whatsoever.
				for (const m of f.svg.matchAll(/<path d="([^"]*)"/g)) {
					shapes++;
					const coords = m[1].match(/-?\d+(?:\.\d+)?/g) ?? [];
					expect(coords.length).toBeGreaterThan(0);
					for (const c of coords) {
						expect(Number.isFinite(Number(c))).toBe(true);
						expect(Math.abs(Number(c))).toBeLessThanOrEqual(24);
					}
				}
				for (const m of f.svg.matchAll(/points="([^"]*)"/g)) {
					shapes++;
					for (const pt of m[1].split(" ")) {
						const [px, py] = pt.split(",").map(Number);
						expect(Number.isFinite(px)).toBe(true);
						expect(Number.isFinite(py)).toBe(true);
						inX(px);
						inY(py);
					}
				}
				// Guards the guard: a regex that stops matching would otherwise turn
				// this whole test into a pass.
				expect(shapes).toBeGreaterThan(0);
			});
		});
	}

	it("uses each palette's own ink, so the pair is not two copies", () => {
		const dark = files.find((f) => f.name === "accounts-dark.svg")?.svg ?? "";
		const light = files.find((f) => f.name === "accounts-light.svg")?.svg ?? "";
		expect(dark).toContain("#e8eff1");
		expect(dark).not.toContain("#0f1a20");
		expect(light).toContain("#0f1a20");
		expect(light).not.toContain("#e8eff1");
	});

	it("is referenced by the README through a closed <picture>, not a bare <img>", () => {
		// A bare <img> would pin one theme's screenshot onto both GitHub themes.
		// Matching the whole element rather than the two paths separately is what
		// makes this a structural check: the substrings alone would also be
		// satisfied by two unrelated images, or by an unclosed tag.
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		const blocks = [
			...readme.matchAll(
				/<picture><source media="\(prefers-color-scheme: dark\)" srcset="(docs\/media\/[^"]+)"><img src="(docs\/media\/[^"]+)"[^>]*><\/picture>/g,
			),
		];
		const darkFiles = files
			.filter((f) => f.name.endsWith("-dark.svg"))
			.map((f) => f.name);
		expect(blocks).toHaveLength(darkFiles.length);

		for (const [, dark, light] of blocks) {
			// The pair inside one <picture> must be the two halves of the SAME image.
			expect(dark.replace("-dark.svg", "")).toBe(
				light.replace("-light.svg", ""),
			);
			expect(existsSync(join(ROOT, dark))).toBe(true);
			expect(existsSync(join(ROOT, light))).toBe(true);
		}
		expect(blocks.map((b) => b[1]).sort()).toEqual(
			darkFiles.map((n) => `docs/media/${n}`).sort(),
		);

		// Nothing may reference the media outside a <picture>.
		const stripped = readme.replace(
			/<picture>.*?<\/picture>/g,
			"",
		);
		expect(stripped).not.toContain("docs/media/");
	});

	it("gives every screenshot alt text describing what is in it", () => {
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		for (const m of readme.matchAll(/<img src="docs\/media\/([^"]+)"[^>]*>/g)) {
			const alt = m[0].match(/alt="([^"]*)"/)?.[1];
			// The logo's alt is deliberately empty: it sits beside the project name
			// in the heading, so announcing it would repeat the word "ClankerMux".
			if (m[1].startsWith("logo-")) expect(alt).toBe("");
			else expect((alt ?? "").length).toBeGreaterThan(40);
		}
	});
});
