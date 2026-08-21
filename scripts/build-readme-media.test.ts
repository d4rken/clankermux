import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function textSpans(svg: string): Span[] {
	const spans: Span[] = [];
	for (const m of svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
		const [, attrs, body] = m;
		const attr = (name: string) =>
			attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1];
		const x = Number(attr("x"));
		const size = Number(attr("font-size"));
		const mono = (attr("font-family") ?? "").includes("Geist Mono");
		const anchor = attr("text-anchor") ?? "start";
		const w = textWidth(body, size, mono);
		const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
		spans.push({
			text: body,
			left,
			right: left + w,
			baseline: Number(attr("y")),
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

	for (const f of files) {
		describe(f.name, () => {
			it("carries no CSS", () => {
				// An <img>-referenced SVG renders in secure static mode and GitHub is
				// free to sanitise what it proxies. Presentation attributes survive
				// both; a <style> block is not guaranteed to.
				expect(f.svg).not.toContain("<style");
				expect(f.svg).not.toContain("@media");
				expect(f.svg).not.toContain("class=");
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
				for (const m of f.svg.matchAll(/<rect ([^>]*)\/>/g)) {
					const attrs = m[1];
					const n = (name: string) =>
						Number(attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1]);
					expect(n("x") + n("width")).toBeLessThanOrEqual(CANVAS_WIDTH + 0.5);
					expect(n("y") + n("height")).toBeLessThanOrEqual(height + 0.5);
					expect(n("x")).toBeGreaterThanOrEqual(-0.5);
					expect(n("y")).toBeGreaterThanOrEqual(-0.5);
				}
				for (const m of f.svg.matchAll(/points="([^"]*)"/g)) {
					for (const pt of m[1].split(" ")) {
						const [px, py] = pt.split(",").map(Number);
						expect(px).toBeLessThanOrEqual(CANVAS_WIDTH + 0.5);
						expect(py).toBeLessThanOrEqual(height + 0.5);
					}
				}
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

	it("is referenced by the README through <picture>, not a bare <img>", () => {
		// A bare <img> would pin one theme's screenshot onto both GitHub themes.
		const readme = readFileSync(join(ROOT, "README.md"), "utf8");
		for (const f of files) {
			if (!f.name.endsWith("-dark.svg")) continue;
			expect(readme).toContain(`srcset="docs/media/${f.name}"`);
			expect(readme).toContain(
				`src="docs/media/${f.name.replace("-dark", "-light")}"`,
			);
		}
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
