/**
 * pi's system prompt with pi's own harness text taken out. pi renders that
 * text as one head at the very start whenever the preamble is its stock one:
 *
 *   You are an expert coding assistant operating inside pi, …
 *
 *   <tools>
 *   …
 *   </tools>
 *
 *   <rules>
 *   …
 *   </rules>
 *
 *   <docs>
 *   …
 *   </docs>
 *
 * pi sends its prompt as one leading system message (pi-ai collapses later
 * system messages into it). Everything after the head (pi's own later
 * sections, extension sections, raw text an extension appended) is the
 * operator's and is forwarded byte for byte, never parsed.
 */

/** pi's harness text, identical across the pi releases that share it. */
interface PiPromptHead {
	stockPreamble: string;
	/** The sections that follow a stock preamble, in order. */
	sections: readonly string[];
}

const HEADS: ReadonlyArray<{ versions: string[]; head: PiPromptHead }> = [
	{
		versions: ["0.87"],
		head: {
			stockPreamble:
				"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
			sections: ["tools", "rules", "docs"],
		},
	},
];

const BY_VERSION: ReadonlyMap<string, PiPromptHead> = new Map(
	HEADS.flatMap(({ versions, head }) => versions.map((v) => [v, head])),
);

/** Every version with a head; `SUPPORTED_PI_PROMPT_VERSIONS` must list exactly these. */
export const PI_PROMPT_HEAD_VERSIONS: readonly string[] = [
	...BY_VERSION.keys(),
];

export function piPromptHead(version: string): PiPromptHead | null {
	return BY_VERSION.get(version) ?? null;
}

/** The text the in-pi bridge refused to forward: subscription accounts answer it with a 400. */
const PI_PREAMBLE_LINE =
	"You are an expert coding assistant operating inside pi";
const TRIGGER_PAIR = ["docs/custom-provider.md", "docs/packages.md"] as const;

const MAX_SECTION_NAMES = 32;

export type PiPromptMalformedReason =
	| "duplicate_closing_tag"
	| "incomplete_head";
export type PiPromptRefusedReason = "trigger_preamble" | "trigger_docs_pair";

export type PiHeadStrip =
	| {
			ok: true;
			/** Null when nothing is left to append. */
			append: string | null;
			headStripped: boolean;
			/** Section openers seen in what is forwarded; a diagnostic, never a filter. */
			sectionsSeen: string[];
	  }
	| {
			ok: false;
			kind: "malformed";
			reason: PiPromptMalformedReason;
			section: string | null;
	  }
	| { ok: false; kind: "refused"; reason: PiPromptRefusedReason };

function countOf(text: string, needle: string): number {
	let n = 0;
	for (
		let at = text.indexOf(needle);
		at !== -1;
		at = text.indexOf(needle, at + needle.length)
	)
		n++;
	return n;
}

/** Where the block `<name>\n…\n</name>` starting at `pos` ends, when a blank line or the end follows it. */
function blockEnd(text: string, pos: number, name: string): number | null {
	const open = `<${name}>\n`;
	if (!text.startsWith(open, pos)) return null;
	const close = `\n</${name}>`;
	const at = text.indexOf(close, pos + open.length - 1);
	if (at === -1) return null;
	const end = at + close.length;
	return end === text.length || text.startsWith("\n\n", end) ? end : null;
}

/** The end of pi's head, or null when the stock preamble is not followed by all of it. */
function headEnd(text: string, head: PiPromptHead): number | null {
	let pos = head.stockPreamble.length;
	for (const name of head.sections) {
		if (!text.startsWith("\n\n", pos)) return null;
		const end = blockEnd(text, pos + 2, name);
		if (end === null) return null;
		pos = end;
	}
	return pos;
}

function triggerIn(text: string): PiPromptRefusedReason | null {
	for (
		let at = text.indexOf(PI_PREAMBLE_LINE);
		at !== -1;
		at = text.indexOf(PI_PREAMBLE_LINE, at + 1)
	)
		// Mid-line mentions describe pi's prompt; they are not pi's prompt.
		if (at === 0 || text[at - 1] === "\n") return "trigger_preamble";
	return TRIGGER_PAIR.every((t) => text.includes(t))
		? "trigger_docs_pair"
		: null;
}

function sectionsSeen(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(/(?:^|\n\n)<([a-z][a-z0-9_-]{0,63})>\n/g))
		if (match[1] && names.size < MAX_SECTION_NAMES) names.add(match[1]);
	return [...names];
}

/**
 * What of pi's system prompt reaches Claude Code: the text after pi's head,
 * or the whole text when it does not start with the stock preamble (a
 * replaced preamble, or a forced prompt without pi's head).
 */
export function stripPiHead(text: string, head: PiPromptHead): PiHeadStrip {
	// A second closing tag could move the head's end.
	for (const name of head.sections)
		if (countOf(text, `</${name}>`) > 1)
			return {
				ok: false,
				kind: "malformed",
				reason: "duplicate_closing_tag",
				section: name,
			};
	const stock = text.startsWith(head.stockPreamble);
	let forwarded = text;
	if (stock) {
		const end = headEnd(text, head);
		if (end === null)
			return {
				ok: false,
				kind: "malformed",
				reason: "incomplete_head",
				section: null,
			};
		forwarded = text.slice(Math.min(end + 2, text.length));
	}
	const trigger = triggerIn(forwarded);
	if (trigger) return { ok: false, kind: "refused", reason: trigger };
	return {
		ok: true,
		append: forwarded || null,
		headStripped: stock,
		sectionsSeen: sectionsSeen(forwarded),
	};
}
