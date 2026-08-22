#!/usr/bin/env bun
/**
 * Generates the README's logo and the four dashboard mockups in `docs/media/`.
 *
 * These are NOT screen captures. Nothing in this repo can rasterise a page —
 * there is no headless browser and no SVG converter on the build host — and a
 * real capture of a working install would put live account addresses, spend and
 * usage into a public README. So the figures are drawn from the same tokens the
 * app itself uses, with invented accounts.
 *
 * Two consequences worth knowing before editing:
 *
 *  - Every colour below is copied from `packages/dashboard-web/styles/globals.css`.
 *    They are duplicated rather than imported because that file is Tailwind
 *    source, not a module, and half its values are `oklch()`, which SVG
 *    renderers do not reliably support. When the theme moves, these move by
 *    hand — `bun run build:readme-media` then re-emits every file.
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
// Verbatim from globals.css. The `oklch()` tokens (--warning, --success) are
// resolved to their sRGB hex here, since an SVG renderer cannot be assumed to
// parse oklch; the `-strong` variants were already hex.

interface Palette {
	background: string;
	foreground: string;
	card: string;
	border: string;
	muted: string;
	mutedForeground: string;
	primary: string;
	primaryForeground: string;
	secondary: string;
	accent: string;
	successStrong: string;
	warningStrong: string;
	destructiveStrong: string;
	info: string;
	/** Chart series, in the order the dashboard assigns them. */
	series: string[];
}

const LIGHT: Palette = {
	background: "#eef1f2",
	foreground: "#0f1a20",
	card: "#ffffff",
	border: "#d9e0e2",
	muted: "#e4eaec",
	mutedForeground: "#5c6d74",
	primary: "#0f6d74",
	primaryForeground: "#ffffff",
	secondary: "#e4eaec",
	accent: "#dde7e8",
	successStrong: "#14663f",
	warningStrong: "#8a5d00",
	destructiveStrong: "#a82b22",
	info: "#0f5b87",
	series: ["#0f6d74", "#a1512c", "#4a5aa8", "#7a2f6a", "#3f6b1f"],
};

const DARK: Palette = {
	background: "#10171a",
	foreground: "#e8eff1",
	card: "#172125",
	border: "#26343a",
	muted: "#1d282c",
	mutedForeground: "#7c939b",
	primary: "#4fb8be",
	primaryForeground: "#04191b",
	secondary: "#1d282c",
	accent: "#223035",
	successStrong: "#62c79a",
	warningStrong: "#e3bd6a",
	destructiveStrong: "#ec8a80",
	info: "#7fc4e0",
	series: ["#4fb8be", "#e0975e", "#8fa2f0", "#d98ad0", "#9ccf6a"],
};

// ── Geometry, taken from the app ────────────────────────────────────────────

/**
 * Canvas width. GitHub caps README content at roughly 880px, so whatever this
 * is gets scaled down to fit — which means a wider canvas does not show more,
 * it just renders every label smaller. 1080 is the narrowest that still holds a
 * full account card's chip row without wrapping, so it is the most legible
 * version of these figures rather than the largest.
 */
const W = 1080;
const SIDEBAR = 192; // w-48
const PAD = 16; // --space-group, the card interior
const R = 3; // --radius

const SANS =
	"Geist, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO =
	"'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// ── SVG helpers ─────────────────────────────────────────────────────────────

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Approximate advance width. There is no text metric available here, so chip
 * and pill backgrounds are sized from these ratios plus padding. They are
 * deliberate over-estimates: a chip a couple of pixels too wide is invisible,
 * one too narrow clips its own label.
 */
function textWidth(text: string, size: number, mono = false): number {
	if (mono) return text.length * size * 0.6;
	let w = 0;
	for (const ch of text) {
		// The wide pair is tested BEFORE the caps/digits class, which also matches
		// M and W. Tested after, that branch is unreachable for uppercase and every
		// "M"/"W" is measured a fifth too narrow — which is how "Max 20x" and
		// "Weekly" were being under-allocated.
		if (/[mwMW]/.test(ch)) w += size * 0.85;
		else if (/[iljtfr.,:;'!|]/.test(ch)) w += size * 0.31;
		else if (/[A-Z0-9]/.test(ch)) w += size * 0.62;
		else w += size * 0.53;
	}
	return w;
}

/** Composite `hex` over `over` at `alpha` — the app's `bg-x/15` tints. */
function tint(hex: string, over: string, alpha: number): string {
	const parse = (h: string) => [
		Number.parseInt(h.slice(1, 3), 16),
		Number.parseInt(h.slice(3, 5), 16),
		Number.parseInt(h.slice(5, 7), 16),
	];
	const [r1, g1, b1] = parse(hex);
	const [r2, g2, b2] = parse(over);
	const mix = (a: number, b: number) => Math.round(a * alpha + b * (1 - alpha));
	return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
}

interface TextOpts {
	size?: number;
	fill?: string;
	weight?: number | string;
	mono?: boolean;
	anchor?: "start" | "middle" | "end";
	opacity?: number;
	tracking?: number;
}

function text(x: number, y: number, s: string, o: TextOpts = {}): string {
	const size = o.size ?? 13;
	const attrs = [
		`x="${round(x)}"`,
		`y="${round(y)}"`,
		`font-family="${o.mono ? MONO : SANS}"`,
		`font-size="${size}"`,
		`fill="${o.fill ?? "currentColor"}"`,
	];
	if (o.weight) attrs.push(`font-weight="${o.weight}"`);
	if (o.anchor && o.anchor !== "start")
		attrs.push(`text-anchor="${o.anchor}"`);
	if (o.opacity != null) attrs.push(`opacity="${o.opacity}"`);
	if (o.tracking) attrs.push(`letter-spacing="${o.tracking}"`);
	return `<text ${attrs.join(" ")}>${esc(s)}</text>`;
}

function round(n: number): number {
	return Math.round(n * 10) / 10;
}

function rect(
	x: number,
	y: number,
	w: number,
	h: number,
	o: {
		fill?: string;
		stroke?: string;
		rx?: number;
		opacity?: number;
	} = {},
): string {
	const attrs = [
		`x="${round(x)}"`,
		`y="${round(y)}"`,
		`width="${round(w)}"`,
		`height="${round(h)}"`,
		`rx="${o.rx ?? R}"`,
		`fill="${o.fill ?? "none"}"`,
	];
	if (o.stroke) attrs.push(`stroke="${o.stroke}"`);
	if (o.opacity != null) attrs.push(`opacity="${o.opacity}"`);
	return `<rect ${attrs.join(" ")}/>`;
}

/** A bordered panel — the app's `<Card>`: 1px border, --radius, no shadow. */
function card(x: number, y: number, w: number, h: number, p: Palette): string {
	return rect(x, y, w, h, { fill: p.card, stroke: p.border });
}

export interface Pill {
	label: string;
	boxLeft: number;
	boxRight: number;
	textLeft: number;
	textRight: number;
}

/**
 * Geometry of every pill drawn during the current render.
 *
 * Recorded here rather than recovered from the finished markup: a rect followed
 * by a text element is not enough to identify a pill — a nav row is an icon
 * square followed by its label and looks identical — so a test reading the SVG
 * back cannot tell the two apart. This is the exact truth instead.
 */
let currentPills: Pill[] = [];

/**
 * A chip. Returns the markup and the width it consumed, so callers can lay a
 * row of them out left to right without measuring twice.
 */
function chip(
	x: number,
	y: number,
	label: string,
	o: {
		fill: string;
		text: string;
		stroke?: string;
		size?: number;
		mono?: boolean;
		weight?: number;
	},
): { svg: string; w: number } {
	const size = o.size ?? 11;
	const h = size + 9;
	const pad = 7;
	const labelW = textWidth(label, size, o.mono);
	const w = labelW + pad * 2;
	const svg =
		rect(x, y, w, h, { fill: o.fill, stroke: o.stroke, rx: 2 }) +
		text(x + pad, y + h - Math.round(size * 0.42), label, {
			size,
			fill: o.text,
			weight: o.weight ?? 500,
			mono: o.mono,
		});
	currentPills.push({
		label,
		boxLeft: x,
		boxRight: x + w,
		textLeft: x + pad,
		textRight: x + pad + labelW,
	});
	return { svg, w };
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

// ── Shared chrome ───────────────────────────────────────────────────────────

const NAV = [
	"Overview",
	"Analytics",
	"Usage",
	"Requests",
	"Accounts",
	"Routing Chains",
	"API Keys",
	"Logs",
	"System",
	"Settings",
];

/** Sidebar: brand block, hairline, nav list, version footer. */
function sidebar(active: string, p: Palette, H: number): string {
	const out: string[] = [];
	out.push(rect(0, 0, SIDEBAR, H, { fill: p.card, rx: 0 }));
	out.push(
		`<line x1="${SIDEBAR}" y1="0" x2="${SIDEBAR}" y2="${H}" stroke="${p.border}"/>`,
	);

	out.push(brandMark(PAD, 18, 24, p.primary));
	out.push(
		text(PAD + 32, 30, "ClankerMux", {
			size: 16,
			weight: 600,
			fill: p.foreground,
			tracking: -0.3,
		}),
	);
	out.push(
		text(PAD + 32, 45, "Rate-Unlimiter", { size: 11, fill: p.mutedForeground }),
	);
	out.push(
		`<line x1="0" y1="62" x2="${SIDEBAR}" y2="62" stroke="${p.border}"/>`,
	);

	let y = 74;
	for (const item of NAV) {
		const on = item === active;
		if (on) {
			out.push(
				rect(8, y, SIDEBAR - 16, 30, {
					fill: tint(p.primary, p.card, 0.12),
					rx: 2,
				}),
			);
		}
		// Nav glyph: a small square, standing in for the lucide icon.
		out.push(
			rect(18, y + 11, 8, 8, {
				fill: "none",
				stroke: on ? p.primary : p.mutedForeground,
				rx: 1,
			}),
		);
		out.push(
			text(36, y + 20, item, {
				size: 12.5,
				weight: on ? 600 : 400,
				fill: on ? p.primary : p.foreground,
				opacity: on ? 1 : 0.82,
			}),
		);
		y += 34;
	}

	out.push(
		`<line x1="0" y1="${H - 46}" x2="${SIDEBAR}" y2="${H - 46}" stroke="${p.border}"/>`,
	);
	out.push(
		text(PAD, H - 26, "v2026.8.56", {
			size: 11,
			mono: true,
			fill: p.mutedForeground,
		}),
	);
	return out.join("");
}

/** Page heading plus the hairline under it. */
function pageTitle(title: string, p: Palette): string {
	return (
		text(SIDEBAR + 24, 44, title, {
			size: 24,
			weight: 600,
			fill: p.foreground,
			tracking: -0.5,
		}) +
		`<line x1="${SIDEBAR + 24}" y1="62" x2="${W - 24}" y2="62" stroke="${p.border}"/>`
	);
}

/** Card title with the subtitle 0.5rem beneath it — the app's title/subtitle pair. */
function cardHeading(
	x: number,
	y: number,
	title: string,
	subtitle: string | null,
	p: Palette,
): string {
	const out = [
		text(x, y, title, {
			size: 15,
			weight: 600,
			fill: p.foreground,
			tracking: -0.2,
		}),
	];
	if (subtitle)
		out.push(text(x, y + 19, subtitle, { size: 12.5, fill: p.mutedForeground }));
	return out.join("");
}

/**
 * Frame height is per view, computed from what the view actually draws. The
 * app's cards size to their content and let the page ground show below them, so
 * a fixed canvas would add a band of empty card that the real page never has.
 */
function frame(body: string, p: Palette, H: number): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` +
		rect(0, 0, W, H, { fill: p.background, rx: 0 }) +
		body +
		`</svg>\n`
	);
}

// ── View: Overview ──────────────────────────────────────────────────────────

function overview(p: Palette): string {
	const H = 592;
	const out: string[] = [sidebar("Overview", p, H), pageTitle("Overview", p)];
	const x = SIDEBAR + 24;
	const w = W - x - 24;

	// Health strip.
	out.push(card(x, 82, w, 44, p));
	out.push(
		`<circle cx="${x + PAD + 5}" cy="104" r="5" fill="${p.successStrong}"/>`,
	);
	out.push(
		text(x + PAD + 18, 108, "All Systems Operational", {
			size: 13,
			weight: 500,
			fill: p.successStrong,
		}),
	);
	const facts = [
		"up 6d 4h",
		"loop 1.2 ms",
		"RSS 214 MB",
		"DB verified",
		"6 accounts live",
	];
	let fx = x + 196;
	for (const f of facts) {
		out.push(text(fx, 108, f, { size: 12, fill: p.mutedForeground }));
		fx += textWidth(f, 12) + 26;
	}

	// Metric tiles.
	const tiles = [
		{ label: "REQUESTS · 24H", value: "18,402", sub: "+12% vs yesterday" },
		{ label: "SUCCESS RATE", value: "99.7%", sub: "54 failed of 18,402" },
		{ label: "TOKENS · 24H", value: "1.42B", sub: "94% served from cache" },
		{ label: "PLAN VALUE · 24H", value: "$2,338.91", sub: "$40.00 amortized" },
	];
	const tw = (w - 3 * PAD) / 4;
	tiles.forEach((t, i) => {
		const tx = x + i * (tw + PAD);
		out.push(card(tx, 142, tw, 92, p));
		out.push(
			text(tx + PAD, 166, t.label, {
				size: 10.5,
				weight: 600,
				fill: p.mutedForeground,
				tracking: 0.9,
			}),
		);
		out.push(
			text(tx + PAD, 196, t.value, {
				size: 24,
				weight: 500,
				fill: p.foreground,
				tracking: -0.5,
			}),
		);
		out.push(
			text(tx + PAD, 217, t.sub, { size: 11.5, fill: p.mutedForeground }),
		);
	});

	// Traffic chart.
	const cy = 250;
	const ch = H - cy - 24;
	out.push(card(x, cy, w, ch, p));
	out.push(
		cardHeading(
			x + PAD,
			cy + 26,
			"Requests over time",
			"Per-account throughput across the pool, hourly buckets.",
			p,
		),
	);

	const plotX = x + PAD + 34;
	const plotY = cy + 74;
	const plotW = w - 2 * PAD - 34;
	const plotH = ch - 74 - 46;

	for (let i = 0; i <= 4; i++) {
		const gy = plotY + (plotH / 4) * i;
		out.push(
			`<line x1="${plotX}" y1="${round(gy)}" x2="${round(plotX + plotW)}" y2="${round(gy)}" stroke="${p.border}"/>`,
		);
		out.push(
			text(plotX - 10, gy + 4, `${(4 - i) * 250}`, {
				size: 10.5,
				mono: true,
				fill: p.mutedForeground,
				anchor: "end",
			}),
		);
	}

	// Deterministic pseudo-traffic: a daily rhythm plus a fixed wobble, so the
	// shape reads as real telemetry and is identical on every regeneration.
	const N = 48;
	const seriesNames = ["workhorse", "nightshift", "spillover"];
	seriesNames.forEach((_, s) => {
		const pts: string[] = [];
		for (let i = 0; i < N; i++) {
			const t = i / (N - 1);
			const daily = Math.sin(t * Math.PI * 2 - 1.2 + s * 0.7) * 0.32 + 0.42;
			const wobble = Math.sin(i * (1.7 + s * 0.55)) * 0.07;
			const v = Math.max(0.04, Math.min(0.97, daily + wobble - s * 0.09));
			pts.push(
				`${round(plotX + t * plotW)},${round(plotY + plotH - v * plotH)}`,
			);
		}
		out.push(
			`<polyline points="${pts.join(" ")}" fill="none" stroke="${p.series[s]}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`,
		);
	});

	// Legend.
	let lx = plotX;
	seriesNames.forEach((name, s) => {
		out.push(
			`<line x1="${round(lx)}" y1="${H - 44}" x2="${round(lx + 14)}" y2="${H - 44}" stroke="${p.series[s]}" stroke-width="1.6"/>`,
		);
		out.push(
			text(lx + 20, H - 40, name, { size: 11.5, fill: p.mutedForeground }),
		);
		lx += textWidth(name, 11.5) + 44;
	});

	return frame(out.join(""), p, H);
}

// ── View: Accounts ──────────────────────────────────────────────────────────

interface MockAccount {
	name: string;
	provider: string;
	identity: string;
	chips: { label: string; tone: "ok" | "warn" | "bad" | "plain" }[];
	counts: string;
	windows: { label: string; pct: number; when: string }[];
}

const ACCOUNTS: MockAccount[] = [
	{
		name: "workhorse",
		provider: "Anthropic",
		identity: "ada@example.com · Example Org · Max 20x · #b3ae60c2",
		chips: [
			{ label: "Primary", tone: "plain" },
			{ label: "Priority: 50", tone: "plain" },
			{ label: "Healthy · 4h 42m", tone: "ok" },
			{ label: "Renews Sep 8 (18d)", tone: "plain" },
		],
		counts: "356,857 requests · 5 clients (15m) · Active: 576 reqs · $284.12 plan",
		windows: [
			{ label: "5-hour", pct: 34, when: "1h 21m · 19:19" },
			{ label: "Weekly", pct: 72, when: "3d 11h · Aug 25, 04:59" },
			{ label: "Fable", pct: 38, when: "3d 11h · Aug 25, 04:59" },
		],
	},
	{
		name: "nightshift",
		provider: "Anthropic",
		identity: "grace@example.com · Example Org · Max 20x · #5fc48dc9",
		chips: [
			{ label: "Priority: 25", tone: "plain" },
			{ label: "Near limit · 83h 2m", tone: "warn" },
			{ label: "Fable weekly exhausted (84h)", tone: "warn" },
			{ label: "Renews Sep 18 (28d)", tone: "plain" },
		],
		counts: "318,536 requests · 2 clients (15m) · Active: 228 reqs · $68.87 plan",
		windows: [
			{ label: "5-hour", pct: 16, when: "1h 21m · 19:19" },
			{ label: "Weekly", pct: 91, when: "3d 11h · Aug 25, 04:59" },
			{ label: "Fable", pct: 100, when: "3d 11h · Aug 25, 04:59" },
		],
	},
	{
		name: "codex-main",
		provider: "OpenAI",
		identity: "ada@example.com · Pro · #ca65c32f",
		chips: [
			{ label: "Priority: 50", tone: "plain" },
			{ label: "0 usage resets", tone: "plain" },
			{ label: "Renews Sep 5 (15d)", tone: "plain" },
		],
		counts: "127,942 requests · 5 clients (15m) · Active: 576 reqs · $28.32 plan",
		windows: [
			{ label: "Weekly", pct: 28, when: "5d 15h · Aug 27, 09:46" },
			{ label: "GPT-5.3-Codex-Spark", pct: 4, when: "6d 23h · Aug 28, 17:55" },
		],
	},
];

/** Height of one account card. Quota panels end at 138; 16 below matches above. */
const ACCOUNT_CARD_H = 154;

function accountCard(
	x: number,
	y: number,
	w: number,
	a: MockAccount,
	p: Palette,
): { svg: string; h: number } {
	const out: string[] = [];
	const h = ACCOUNT_CARD_H;
	out.push(rect(x, y, w, h, { fill: p.card, stroke: p.border }));

	const ix = x + PAD;
	// Identity group: name row, then the address line 0.25rem under it.
	out.push(
		text(ix, y + 26, a.name, { size: 15, weight: 600, fill: p.foreground }),
	);
	const nameW = textWidth(a.name, 15) + 10;
	const pc = chip(ix + nameW, y + 14, a.provider, {
		fill: tint(p.primary, p.card, 0.12),
		text: p.primary,
		size: 10.5,
	});
	out.push(pc.svg);
	out.push(
		text(ix, y + 44, a.identity, { size: 11.5, fill: p.mutedForeground }),
	);

	// Action glyphs, right-aligned with the card interior.
	for (let i = 0; i < 5; i++) {
		const bx = x + w - PAD - 22 - i * 26;
		out.push(
			rect(bx, y + 12, 18, 18, { fill: "none", stroke: p.border, rx: 2 }),
		);
	}

	// Status group: chips, then the counts row one step under them.
	let cx = ix;
	for (const c of a.chips) {
		const tone =
			c.tone === "ok"
				? { fill: tint(p.successStrong, p.card, 0.16), text: p.successStrong }
				: c.tone === "warn"
					? { fill: tint(p.warningStrong, p.card, 0.16), text: p.warningStrong }
					: c.tone === "bad"
						? {
								fill: tint(p.destructiveStrong, p.card, 0.16),
								text: p.destructiveStrong,
							}
						: { fill: p.secondary, text: p.foreground };
		const made = chip(cx, y + 56, c.label, tone);
		out.push(made.svg);
		cx += made.w + 8;
	}
	out.push(text(ix, y + 94, a.counts, { size: 12, fill: p.mutedForeground }));

	// Quota group: one bordered window panel per limit.
	const gap = 10;
	const bw = (w - 2 * PAD - gap * (a.windows.length - 1)) / a.windows.length;
	a.windows.forEach((win, i) => {
		const bx = ix + i * (bw + gap);
		const by = y + 104;
		out.push(rect(bx, by, bw, 34, { fill: "none", stroke: p.border, rx: 2 }));
		// Bar tone follows the app: amber past 80%, red at the ceiling.
		const barColor =
			win.pct >= 100
				? p.destructiveStrong
				: win.pct >= 80
					? p.warningStrong
					: p.primary;
		out.push(
			rect(bx + 8, by + 7, bw - 16, 5, { fill: p.muted, rx: 2 }),
		);
		out.push(
			rect(bx + 8, by + 7, ((bw - 16) * win.pct) / 100, 5, {
				fill: barColor,
				rx: 2,
			}),
		);
		out.push(
			text(bx + 8, by + 27, win.label, { size: 11, fill: p.mutedForeground }),
		);
		out.push(
			text(bx + bw - 8, by + 27, `${win.pct}%`, {
				size: 11,
				mono: true,
				fill: p.foreground,
				anchor: "end",
			}),
		);
		out.push(
			text(bx + bw / 2, by + 27, win.when, {
				size: 10.5,
				fill: p.mutedForeground,
				anchor: "middle",
			}),
		);
	});

	return { svg: out.join(""), h };
}

function accounts(p: Palette): string {
	const listTop = 148;
	// Cards are separated by --space-group, which is one step wider than the
	// widest gap inside a card, and the list closes with the card's own padding.
	const listH =
		ACCOUNTS.length * ACCOUNT_CARD_H + (ACCOUNTS.length - 1) * PAD;
	const outerH = listTop - 82 + listH + PAD;
	const H = 82 + outerH + 24;

	const out: string[] = [sidebar("Accounts", p, H), pageTitle("Accounts", p)];
	const x = SIDEBAR + 24;
	const w = W - x - 24;

	out.push(card(x, 82, w, outerH, p));
	out.push(
		cardHeading(x + PAD, 108, "Accounts", "Manage your proxy accounts", p),
	);

	const btn = "+  Add Account";
	const bw = textWidth(btn, 12.5) + 26;
	out.push(
		rect(x + w - PAD - bw, 94, bw, 30, { fill: p.primary, rx: 2 }),
	);
	out.push(
		text(x + w - PAD - bw / 2, 113, btn, {
			size: 12.5,
			weight: 500,
			fill: p.primaryForeground,
			anchor: "middle",
		}),
	);

	let y = listTop;
	for (const a of ACCOUNTS) {
		const made = accountCard(x + PAD, y, w - 2 * PAD, a, p);
		out.push(made.svg);
		y += made.h + PAD;
	}

	return frame(out.join(""), p, H);
}

// ── View: Request history ───────────────────────────────────────────────────

interface MockRequest {
	time: string;
	status: number;
	account: string;
	ms: string;
	id: string;
	project: string;
	agent: string;
	model: string;
	tokens: string;
	rate: string;
	cost: string;
}

const REQUESTS: MockRequest[] = [
	{
		time: "17:59:29",
		status: 200,
		account: "workhorse",
		ms: "2.5s",
		id: "786d3820",
		project: "capod",
		agent: "claudecode",
		model: "claude-sonnet-5",
		tokens: "237,448 tokens (35 fresh)",
		rate: "22.0 tok/s",
		cost: "$0.0483",
	},
	{
		time: "17:59:24",
		status: 200,
		account: "workhorse",
		ms: "4.2s",
		id: "afbe807e",
		project: "capod",
		agent: "claudecode",
		model: "claude-sonnet-5",
		tokens: "65,642 tokens (5,523 fresh)",
		rate: "89.5 tok/s",
		cost: "$0.0529",
	},
	{
		time: "17:59:18",
		status: 200,
		account: "nightshift",
		ms: "5.4s",
		id: "ecc823ce",
		project: "butler",
		agent: "claudecode",
		model: "claude-opus-5",
		tokens: "226,697 tokens (485 fresh)",
		rate: "106.1 tok/s",
		cost: "$0.1270",
	},
	{
		time: "17:59:16",
		status: 429,
		account: "nightshift",
		ms: "0.3s",
		id: "1fea0f9c",
		project: "butler",
		agent: "claudecode",
		model: "claude-opus-5",
		tokens: "rate limited · failed over",
		rate: "retry 1",
		cost: "$0.0000",
	},
	{
		time: "17:59:07",
		status: 200,
		account: "codex-main",
		ms: "3.8s",
		id: "fe629e2d",
		project: "capod",
		agent: "codex",
		model: "gpt-5.3-codex",
		tokens: "226,110 tokens (349 fresh)",
		rate: "131.5 tok/s",
		cost: "$0.1310",
	},
];

const REQUEST_ROW_H = 88;
const REQUEST_ROW_GAP = 12;

function requests(p: Palette): string {
	const listTop = 148;
	const listH =
		REQUESTS.length * REQUEST_ROW_H + (REQUESTS.length - 1) * REQUEST_ROW_GAP;
	const outerH = listTop - 82 + listH + PAD;
	const H = 82 + outerH + 24;

	const out: string[] = [sidebar("Requests", p, H), pageTitle("Requests", p)];
	const x = SIDEBAR + 24;
	const w = W - x - 24;

	out.push(card(x, 82, w, outerH, p));
	out.push(
		cardHeading(x + PAD, 108, "Request History", "Live · latest 50 requests", p),
	);
	const fbw = textWidth("Filters", 12.5) + 34;
	out.push(
		rect(x + w - PAD - fbw, 94, fbw, 30, { fill: "none", stroke: p.border, rx: 2 }),
	);
	out.push(
		text(x + w - PAD - fbw / 2, 113, "Filters", {
			size: 12.5,
			fill: p.foreground,
			anchor: "middle",
		}),
	);

	let y = listTop;
	const rw = w - 2 * PAD;
	for (const r of REQUESTS) {
		const rx = x + PAD;
		const rh = REQUEST_ROW_H;
		const err = r.status >= 400;
		out.push(
			rect(rx, y, rw, rh, {
				fill: "none",
				stroke: err ? tint(p.destructiveStrong, p.card, 0.5) : p.border,
				rx: 2,
			}),
		);

		// Row 1: time, status, method, account, then timing and id right-aligned.
		const ry = y + 22;
		out.push(
			text(rx + 12, ry, r.time, {
				size: 11.5,
				mono: true,
				fill: p.mutedForeground,
			}),
		);
		const status = chip(rx + 72, ry - 13, String(r.status), {
			fill: err
				? tint(p.destructiveStrong, p.card, 0.16)
				: tint(p.successStrong, p.card, 0.16),
			text: err ? p.destructiveStrong : p.successStrong,
			size: 11.5,
			mono: true,
			weight: 600,
		});
		out.push(status.svg);
		out.push(
			text(rx + 72 + status.w + 12, ry, "POST", {
				size: 11.5,
				weight: 600,
				fill: p.foreground,
			}),
		);
		out.push(
			text(rx + 72 + status.w + 56, ry, `via ${r.account}`, {
				size: 11.5,
				fill: p.mutedForeground,
			}),
		);
		out.push(
			text(rx + rw - 92, ry, r.ms, {
				size: 11.5,
				mono: true,
				fill: p.mutedForeground,
				anchor: "end",
			}),
		);
		out.push(
			text(rx + rw - 12, ry, r.id, {
				size: 11.5,
				mono: true,
				fill: p.mutedForeground,
				anchor: "end",
				opacity: 0.7,
			}),
		);

		// Rows 2 and 3 share row 1's left edge — no hanging indent.
		let cx = rx + 12;
		for (const label of [`⌥ ${r.agent}`, `▤ ${r.project}`]) {
			const made = chip(cx, y + 32, label, {
				fill: "none",
				stroke: p.border,
				text: p.foreground,
			});
			out.push(made.svg);
			cx += made.w + 8;
		}

		cx = rx + 12;
		for (const label of [r.model, r.tokens, r.rate, r.cost]) {
			const made = chip(cx, y + 58, label, {
				fill: p.secondary,
				text: p.foreground,
			});
			out.push(made.svg);
			cx += made.w + 8;
		}

		y += rh + REQUEST_ROW_GAP;
	}

	return frame(out.join(""), p, H);
}

// ── View: Usage ─────────────────────────────────────────────────────────────

function usage(p: Palette): string {
	// Sawtooth card, then the performance card; the latter ends 146 below its
	// own top edge plus one card padding.
	const ch = 386;
	const perfTop = 82 + ch + PAD;
	const H = perfTop + 146 + PAD + 24;

	const out: string[] = [sidebar("Usage", p, H), pageTitle("Usage", p)];
	const x = SIDEBAR + 24;
	const w = W - x - 24;
	out.push(card(x, 82, w, ch, p));
	out.push(
		cardHeading(
			x + PAD,
			108,
			"Usage Over Time",
			"Per-account utilization with the pool average. Dashed lines project the current burn rate to each window's reset.",
			p,
		),
	);
	const sel = "Last 7 days";
	const selW = textWidth(sel, 12.5) + 34;
	out.push(
		rect(x + w - PAD - selW, 94, selW, 30, {
			fill: "none",
			stroke: p.border,
			rx: 2,
		}),
	);
	out.push(
		text(x + w - PAD - selW / 2, 113, sel, {
			size: 12.5,
			fill: p.foreground,
			anchor: "middle",
		}),
	);

	out.push(
		text(x + PAD, 158, "5-HOUR WINDOW", {
			size: 10.5,
			weight: 600,
			fill: p.mutedForeground,
			tracking: 0.9,
		}),
	);

	const plotX = x + PAD + 36;
	const plotY = 172;
	const plotW = w - 2 * PAD - 36;
	const plotH = 226;

	for (let i = 0; i <= 4; i++) {
		const gy = plotY + (plotH / 4) * i;
		out.push(
			`<line x1="${plotX}" y1="${round(gy)}" x2="${round(plotX + plotW)}" y2="${round(gy)}" stroke="${p.border}"/>`,
		);
		out.push(
			text(plotX - 10, gy + 4, `${(4 - i) * 25}%`, {
				size: 10.5,
				mono: true,
				fill: p.mutedForeground,
				anchor: "end",
			}),
		);
	}
	// The 100% ceiling, drawn the way the app draws it.
	out.push(
		`<line x1="${plotX}" y1="${plotY}" x2="${round(plotX + plotW)}" y2="${plotY}" stroke="${p.destructiveStrong}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>`,
	);
	out.push(
		text(plotX + plotW / 2, plotY - 5, "Limit", {
			size: 10.5,
			fill: p.destructiveStrong,
			anchor: "middle",
			opacity: 0.85,
		}),
	);

	// Sawtooth: usage climbs inside a window, drops to zero when it resets.
	const names = ["workhorse", "nightshift", "spillover", "codex-main"];
	const solidEnd = 0.72;
	names.forEach((_, s) => {
		const period = 46 + s * 11;
		const phase = s * 17;
		const peak = 0.94 - s * 0.13;
		const pts: string[] = [];
		const N = 150;
		for (let i = 0; i <= N * solidEnd; i++) {
			const t = i / N;
			const cyc = ((i + phase) % period) / period;
			const v = Math.max(0.02, cyc * peak);
			pts.push(
				`${round(plotX + t * plotW)},${round(plotY + plotH - v * plotH)}`,
			);
		}
		out.push(
			`<polyline points="${pts.join(" ")}" fill="none" stroke="${p.series[s]}" stroke-width="1.5" stroke-linejoin="round"/>`,
		);

		// Forecast: dashed continuation to the window's projected reset.
		const lastV = Math.max(
			0.02,
			(((N * solidEnd + phase) % period) / period) * peak,
		);
		out.push(
			`<polyline points="${round(plotX + solidEnd * plotW)},${round(plotY + plotH - lastV * plotH)} ${round(plotX + plotW)},${round(plotY + plotH - Math.min(1, lastV + 0.5) * plotH)}" fill="none" stroke="${p.series[s]}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.85"/>`,
		);
	});

	let lx = plotX;
	names.forEach((name, s) => {
		out.push(
			`<line x1="${round(lx)}" y1="428" x2="${round(lx + 14)}" y2="428" stroke="${p.series[s]}" stroke-width="1.6"/>`,
		);
		out.push(text(lx + 20, 432, name, { size: 11.5, fill: p.mutedForeground }));
		lx += textWidth(name, 11.5) + 44;
	});

	// Account Performance headline figures.
	const py = perfTop;
	out.push(card(x, py, w, H - py - 24, p));
	out.push(
		cardHeading(
			x + PAD,
			py + 26,
			"Account Performance",
			"Request distribution, success rates, and cost by account",
			p,
		),
	);

	const cols = [
		{
			label: "Plan Value",
			value: "$16,378.28",
			rows: [
				["Avg / day", "$2,339.75"],
				["Avg / week", "$11,359.92"],
			],
		},
		{
			label: "Cost",
			value: "$600.00",
			rows: [
				["Amortized / day", "$40.00"],
				["Amortized / week", "$280.00"],
			],
		},
		{
			label: "Value Ratio",
			value: "27.3×",
			rows: [["plan value ÷ amortized spend", ""]],
		},
	];
	const colW = (w - 2 * PAD) / 3;
	cols.forEach((c, i) => {
		const cxx = x + PAD + i * colW;
		out.push(
			text(cxx, py + 74, c.label, { size: 12.5, fill: p.mutedForeground }),
		);
		out.push(
			text(cxx, py + 104, c.value, {
				size: 24,
				weight: 500,
				fill: p.foreground,
				tracking: -0.5,
			}),
		);
		c.rows.forEach((r, j) => {
			out.push(
				text(cxx, py + 128 + j * 18, r[0], {
					size: 11.5,
					fill: p.mutedForeground,
				}),
			);
			if (r[1])
				out.push(
					text(cxx + colW - 32, py + 128 + j * 18, r[1], {
						size: 11.5,
						weight: 500,
						mono: true,
						fill: p.foreground,
						anchor: "end",
					}),
				);
		});
	});

	return frame(out.join(""), p, H);
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

export const VIEWS: Record<string, (p: Palette) => string> = {
	overview,
	accounts,
	requests,
	usage,
};

export const PALETTES = { light: LIGHT, dark: DARK } as const;

/**
 * Every file this script owns, each with the pill geometry recorded while it was
 * drawn. Exported for the test, which has no other way to know which rects are
 * pills.
 */
export function renderAll(): { name: string; svg: string; pills: Pill[] }[] {
	const files: { name: string; svg: string; pills: Pill[] }[] = [];
	const one = (name: string, draw: () => string) => {
		currentPills = [];
		const svg = draw();
		files.push({ name, svg, pills: currentPills });
	};
	for (const [mode, palette] of Object.entries(PALETTES)) {
		one(`logo-${mode}.svg`, () => logo(palette));
		for (const [view, render] of Object.entries(VIEWS)) {
			one(`${view}-${mode}.svg`, () => render(palette));
		}
	}
	return files;
}

export { textWidth, W as CANVAS_WIDTH };

if (import.meta.main) {
	mkdirSync(OUT_DIR, { recursive: true });
	const files = renderAll();
	for (const f of files) writeFileSync(join(OUT_DIR, f.name), f.svg);
	console.log(`docs/media: wrote ${files.length} files`);
	for (const f of files) console.log(`  ${f.name}`);
}
