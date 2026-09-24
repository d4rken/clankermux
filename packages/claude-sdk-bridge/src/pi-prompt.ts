/**
 * pi's system prompt, read by its outer section edges only. pi renders a
 * leading system message as its preamble followed by `<name>\n…\n</name>`
 * sections, all joined by a blank line:
 *
 *   You are an expert coding assistant operating inside pi, …   (or a custom prompt)
 *
 *   <tools>…</tools>  <rules>…</rules>  <docs>…</docs>          (stock preamble only)
 *   <addendum>…</addendum>  <project_context>…</project_context>
 *   <skills>…</skills>  <cwd>…</cwd>  <extension_name>…</extension_name>
 *
 * A section that changes later in the session arrives as another system
 * message, which the adapters append after a blank line:
 *
 *   Updated system prompt section "skills":
 *
 *   <skills>…</skills>
 *
 *   Removed system prompt section "addendum".
 *
 * Section contents are never looked into: pi does not escape context files,
 * so a record boundary inside `project_context` is indistinguishable from
 * file text.
 */

/** One pi release's prompt layout. */
interface PiPromptLayout {
	stockPreamble: string;
	/** Present exactly when the preamble is the stock one. */
	stockSections: readonly string[];
	/** Every section pi itself renders, in its order. */
	order: readonly string[];
	/** What reaches Claude Code, in this order. */
	kept: readonly string[];
}

const PI_0_87: PiPromptLayout = {
	stockPreamble:
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
	stockSections: ["tools", "rules", "docs"],
	order: [
		"tools",
		"rules",
		"docs",
		"addendum",
		"project_context",
		"skills",
		"cwd",
	],
	kept: ["project_context", "skills", "addendum", "cwd"],
};

const LAYOUTS: ReadonlyMap<string, PiPromptLayout> = new Map([
	["0.87", PI_0_87],
]);

/** Layout versions with fixtures; a pi release outside these is refused. */
export const SUPPORTED_PI_PROMPT_VERSIONS: readonly string[] = [
	...LAYOUTS.keys(),
];

export function piPromptLayout(version: string): PiPromptLayout | null {
	return LAYOUTS.get(version) ?? null;
}

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const OPENER = /<([a-z][a-z0-9_-]*)>\n/y;
const UPDATED = 'Updated system prompt section "';
const REMOVED = 'Removed system prompt section "';

/** The text the in-pi bridge refused to forward: subscription accounts answer it with a 400. */
const PI_PREAMBLE_LINE =
	"You are an expert coding assistant operating inside pi";
const TRIGGER_PAIR = ["docs/custom-provider.md", "docs/packages.md"] as const;

export type PiPromptMalformedReason =
	| "text_between_sections"
	| "unterminated_section"
	| "duplicate_section"
	| "section_out_of_order"
	| "missing_section"
	| "stock_sections_missing"
	| "duplicate_closing_tag"
	| "malformed_section_update";

export type PiPromptRefusedReason = "trigger_preamble" | "trigger_docs_pair";

export type PiProjection =
	| {
			ok: true;
			/** Null when there is nothing to append. */
			append: string | null;
			shape: "stock" | "replaced" | "sectionless" | "empty";
			droppedSections: string[];
			sectionUpdates: number;
	  }
	| {
			ok: false;
			kind: "malformed";
			reason: PiPromptMalformedReason;
			section: string | null;
	  }
	| {
			ok: false;
			kind: "refused";
			reason: PiPromptRefusedReason;
			/** `preamble`, a section name, or `prompt` for sectionless text. */
			section: string;
	  };

class Malformed extends Error {
	constructor(
		readonly reason: PiPromptMalformedReason,
		readonly section: string | null = null,
	) {
		super(reason);
	}
}

/** A name read from the prompt, safe to record and to show. */
function sectionLabel(name: string): string {
	return SECTION_NAME.test(name) || name === "preamble"
		? name.slice(0, 64)
		: "(invalid)";
}

interface Block {
	name: string;
	text: string;
	end: number;
}

/** The section starting at `pos`: `<name>\n`, content, `\n</name>`, then a blank line or the end. */
function readSection(text: string, pos: number, expected?: string): Block {
	OPENER.lastIndex = pos;
	const open = OPENER.exec(text);
	if (!open?.[1])
		throw new Malformed(
			expected ? "malformed_section_update" : "text_between_sections",
			expected ?? null,
		);
	const name = open[1];
	if (expected !== undefined && name !== expected)
		throw new Malformed("malformed_section_update", sectionLabel(expected));
	const close = `\n</${name}>`;
	let at = text.indexOf(close, pos + open[0].length - 1);
	while (at !== -1) {
		const after = at + close.length;
		if (after === text.length || text.startsWith("\n\n", after))
			return { name, text: text.slice(pos, after), end: after };
		at = text.indexOf(close, at + 1);
	}
	throw new Malformed("unterminated_section", sectionLabel(name));
}

/** The quoted name of an update line at `pos`, and where it ends. */
function readUpdateName(
	text: string,
	pos: number,
	terminator: string,
): { name: string; end: number } {
	const close = text.indexOf(terminator, pos);
	const name = close === -1 ? "" : text.slice(pos, close);
	if (!SECTION_NAME.test(name) && name !== "preamble")
		throw new Malformed("malformed_section_update");
	return { name, end: close + terminator.length };
}

function nextUpdateAt(text: string, from: number): number {
	const candidates = [
		text.indexOf(`\n\n${UPDATED}`, from),
		text.indexOf(`\n\n${REMOVED}`, from),
	].filter((i) => i !== -1);
	return candidates.length ? Math.min(...candidates) : text.length;
}

function countOf(text: string, needle: string): number {
	let n = 0;
	for (
		let at = text.indexOf(needle);
		at !== -1;
		at = text.indexOf(needle, at + 1)
	)
		n++;
	return n;
}

interface Sectioned {
	preamble: string;
	sections: Map<string, string>;
	updates: number;
}

/**
 * The preamble ends at the first kept-section opener after a blank line. A
 * replaced preamble is operator text and may well carry `<rules>` or
 * `<example>` blocks of its own, so only a section pi appends after a custom
 * prompt can end it.
 */
function preambleEnd(text: string, layout: PiPromptLayout): number | null {
	if (
		text === layout.stockPreamble ||
		text.startsWith(`${layout.stockPreamble}\n\n`)
	)
		return layout.stockPreamble.length;
	let first: number | null = null;
	for (const name of layout.kept) {
		const at = text.indexOf(`\n\n<${name}>\n`);
		if (at !== -1 && (first === null || at < first)) first = at;
	}
	return first;
}

function parseSectioned(
	text: string,
	layout: PiPromptLayout,
	start: number,
): Sectioned {
	let preamble = text.slice(0, start);
	const sections = new Map<string, string>();
	const blocks = new Map<string, number>();
	const note = (name: string) => blocks.set(name, (blocks.get(name) ?? 0) + 1);
	let rank = -1;
	let pastBuiltIns = false;
	let updates = 0;
	let pos = start;

	while (pos < text.length) {
		if (!text.startsWith("\n\n", pos))
			throw new Malformed(
				updates ? "malformed_section_update" : "text_between_sections",
			);
		pos += 2;
		if (text.startsWith(UPDATED, pos)) {
			updates++;
			const { name, end } = readUpdateName(
				text,
				pos + UPDATED.length,
				'":\n\n',
			);
			if (name === "preamble") {
				const valueEnd = nextUpdateAt(text, end);
				preamble = text.slice(end, valueEnd);
				pos = valueEnd;
				continue;
			}
			const block = readSection(text, end, name);
			note(name);
			sections.set(name, block.text);
			pos = block.end;
			continue;
		}
		if (text.startsWith(REMOVED, pos)) {
			updates++;
			const { name, end } = readUpdateName(text, pos + REMOVED.length, '".');
			if (name === "preamble")
				throw new Malformed("malformed_section_update", name);
			sections.delete(name);
			pos = end;
			continue;
		}
		// The leading message's sections; none may follow an update.
		if (updates) throw new Malformed("malformed_section_update");
		const block = readSection(text, pos);
		const label = sectionLabel(block.name);
		if (sections.has(block.name))
			throw new Malformed("duplicate_section", label);
		const at = layout.order.indexOf(block.name);
		if (at === -1) pastBuiltIns = true;
		else if (at <= rank || pastBuiltIns)
			throw new Malformed("section_out_of_order", label);
		else rank = at;
		note(block.name);
		sections.set(block.name, block.text);
		pos = block.end;
	}

	// Only the terminators the parse consumed may carry a kept section's
	// closing tag; one anywhere else could have moved a section edge.
	for (const name of layout.kept)
		if (countOf(text, `</${name}>`) > (blocks.get(name) ?? 0))
			throw new Malformed("duplicate_closing_tag", name);
	if (preamble === layout.stockPreamble) {
		const missing = layout.stockSections.find((name) => !sections.has(name));
		if (missing) throw new Malformed("stock_sections_missing", missing);
	}
	if (!sections.has("cwd")) throw new Malformed("missing_section", "cwd");
	return { preamble, sections, updates };
}

function triggerIn(
	parts: ReadonlyArray<{ label: string; text: string }>,
): { reason: PiPromptRefusedReason; section: string } | null {
	for (const { label, text } of parts) {
		for (
			let at = text.indexOf(PI_PREAMBLE_LINE);
			at !== -1;
			at = text.indexOf(PI_PREAMBLE_LINE, at + 1)
		)
			// Mid-line mentions describe pi's prompt; they are not pi's prompt.
			if (at === 0 || text[at - 1] === "\n")
				return { reason: "trigger_preamble", section: label };
		if (TRIGGER_PAIR.every((t) => text.includes(t)))
			return { reason: "trigger_docs_pair", section: label };
	}
	return null;
}

/**
 * What of pi's system prompt reaches Claude Code: with the stock preamble,
 * the project context, skills, addendum and cwd sections byte for byte;
 * with a replaced one, the replaced preamble first and then the same; a
 * forced prompt, which has no sections, whole. pi's tool list, rules and
 * docs pointers never do, and neither do sections extensions add.
 */
export function projectPiPrompt(
	text: string,
	layout: PiPromptLayout,
): PiProjection {
	if (!text)
		return {
			ok: true,
			append: null,
			shape: "empty",
			droppedSections: [],
			sectionUpdates: 0,
		};
	const start = preambleEnd(text, layout);
	let parts: Array<{ label: string; text: string }>;
	let shape: "stock" | "replaced" | "sectionless";
	let droppedSections: string[] = [];
	let sectionUpdates = 0;
	if (start === null) {
		parts = [{ label: "prompt", text }];
		shape = "sectionless";
	} else {
		let parsed: Sectioned;
		try {
			parsed = parseSectioned(text, layout, start);
		} catch (error) {
			if (!(error instanceof Malformed)) throw error;
			return {
				ok: false,
				kind: "malformed",
				reason: error.reason,
				section: error.section,
			};
		}
		const stock = parsed.preamble === layout.stockPreamble;
		parts = [
			...(stock || !parsed.preamble
				? []
				: [{ label: "preamble", text: parsed.preamble }]),
			...layout.kept.flatMap((name) => {
				const block = parsed.sections.get(name);
				return block === undefined ? [] : [{ label: name, text: block }];
			}),
		];
		shape = stock ? "stock" : "replaced";
		droppedSections = [...parsed.sections.keys()].filter(
			(name) => !layout.order.includes(name),
		);
		sectionUpdates = parsed.updates;
	}
	const trigger = triggerIn(parts);
	if (trigger) return { ok: false, kind: "refused", ...trigger };
	return {
		ok: true,
		append: parts.length ? parts.map((p) => p.text).join("\n\n") : null,
		shape,
		droppedSections,
		sectionUpdates,
	};
}
