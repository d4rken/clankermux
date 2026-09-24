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
 * Everything after the head (pi's own later sections, extension sections,
 * raw text an extension appended) is the operator's and is forwarded byte
 * for byte, never parsed. A section pi changes mid-session arrives as a
 * later system message, `Updated system prompt section "tools":` and the
 * block; updates to the head's sections are removed with it.
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

/** Layout versions with fixtures; a pi release outside these is refused. */
export const SUPPORTED_PI_PROMPT_VERSIONS: readonly string[] = [
	...BY_VERSION.keys(),
];

export function piPromptHead(version: string): PiPromptHead | null {
	return BY_VERSION.get(version) ?? null;
}

const UPDATED = 'Updated system prompt section "';
const REMOVED = 'Removed system prompt section "';

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
			/** Updates to the head's sections taken out. */
			removedUpdates: number;
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

/**
 * Removes updates that put back or change the head: its sections, or the
 * preamble back to stock. Every other update, and every removal, stays.
 */
function removeHeadUpdates(
	tail: string,
	head: PiPromptHead,
): { text: string; removed: number } {
	// Each update is preceded by a blank line: the one joining it to the text before.
	let text = `\n\n${tail}`;
	let removed = 0;
	for (const name of head.sections) {
		const marker = `\n\n${UPDATED}${name}":\n\n`;
		let at = text.indexOf(marker);
		while (at !== -1) {
			const end = blockEnd(text, at + marker.length, name);
			if (end === null) {
				at = text.indexOf(marker, at + marker.length);
				continue;
			}
			text = text.slice(0, at) + text.slice(end);
			removed++;
			at = text.indexOf(marker, at);
		}
	}
	const stock = `\n\n${UPDATED}preamble":\n\n${head.stockPreamble}`;
	let at = text.indexOf(stock);
	while (at !== -1) {
		const end = at + stock.length;
		if (
			end === text.length ||
			text.startsWith(`\n\n${UPDATED}`, end) ||
			text.startsWith(`\n\n${REMOVED}`, end)
		) {
			text = text.slice(0, at) + text.slice(end);
			removed++;
			at = text.indexOf(stock, at);
		} else at = text.indexOf(stock, end);
	}
	return { text: text.slice(2), removed };
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
	const stock = text.startsWith(head.stockPreamble);
	const updates = (name: string) =>
		countOf(text, `\n\n${UPDATED}${name}":\n\n<${name}>\n`);
	// A second closing tag could move the head's end, or an update's.
	for (const name of head.sections) {
		const allowed = Math.max(1, (stock ? 1 : 0) + updates(name));
		if (countOf(text, `</${name}>`) > allowed)
			return {
				ok: false,
				kind: "malformed",
				reason: "duplicate_closing_tag",
				section: name,
			};
	}
	let tail = text;
	if (stock) {
		const end = headEnd(text, head);
		if (end === null)
			return {
				ok: false,
				kind: "malformed",
				reason: "incomplete_head",
				section: null,
			};
		tail = text.slice(Math.min(end + 2, text.length));
	}
	const { text: forwarded, removed } = removeHeadUpdates(tail, head);
	const trigger = triggerIn(forwarded);
	if (trigger) return { ok: false, kind: "refused", reason: trigger };
	return {
		ok: true,
		append: forwarded || null,
		headStripped: stock,
		removedUpdates: removed,
		sectionsSeen: sectionsSeen(forwarded),
	};
}
