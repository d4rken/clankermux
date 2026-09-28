/**
 * Claude Code tells the model where it runs: a block naming its working
 * directory, platform, shell and OS, and an update block when any of them
 * changes. Under the bridge that is the child's private sandbox on the
 * ClankerMux host, never the client's machine, whose tools the model is
 * really driving. The block is removed from every model call; everything
 * else in the message that carries it stays as it was.
 *
 * Only a block naming one of the bridge's own sandboxes
 * (`<root>/gen-<id>/cwd`) is Claude Code's; the same text naming any other
 * directory is the client's and passes untouched. The shapes are Claude
 * Code's own renderings, pinned against the real binary by "never shows the
 * model Claude Code's own directories, only the client's" in
 * `real-claude.integration.test.ts`.
 */

type Json = Record<string, unknown>;

export interface EnvironmentStripOptions {
	/** The bridge's work roots (as configured and as resolved). */
	roots: readonly string[];
}

export interface EnvironmentStripResult {
	changed: boolean;
	/**
	 * A text under a root that looks like the block but was not taken:
	 * Claude Code's wording may have changed.
	 */
	drift: boolean;
	/** User messages left as they were because the block was all they held. */
	keptInUserMessages: number;
}

const LIST_LINE = String.raw` {1,2}- [^\n]*`;
const FULL = new RegExp(
	String.raw`^# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ([^\n]*)(?:\n${LIST_LINE})*$`,
);
const UPDATE = new RegExp(
	String.raw`^# Environment update(?:\n${LIST_LINE})+$`,
);
const UPDATE_DIR = /^ - Primary working directory: (.*) \(was (.*)\)$/m;
const OPEN = /^<system-reminder>\r?\n/;
const CLOSE = /(?:^|\r?\n)<\/system-reminder>[ \t\r\n]*$/;
/** Blank lines, as Claude Code joins the paragraphs of one message. */
const SEPARATOR = /(\r?\n(?:[ \t]*\r?\n)+)/;
const MARKERS = ["Primary working directory:", "# Environment"];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sandboxMatcher(roots: readonly string[]): (path: string) => boolean {
	const pattern = new RegExp(
		`^(?:${roots.map(escapeRegExp).join("|")})/gen-[A-Za-z0-9_-]{1,100}/cwd$`,
	);
	return (path) => pattern.test(path);
}

/** Whether `core` is the block, naming only sandboxes `owned` accepts. */
function isBlock(core: string, owned: (path: string) => boolean): boolean {
	const text = core.replaceAll("\r\n", "\n").trimEnd();
	const full = FULL.exec(text);
	if (full) return owned((full[1] ?? "").trim());
	if (!UPDATE.test(text)) return false;
	const dirs = UPDATE_DIR.exec(text);
	return !!dirs && owned(dirs[1] ?? "") && owned(dirs[2] ?? "");
}

interface Unit {
	/** The separator before this unit ("" for the first). */
	before: string;
	text: string;
	removed: boolean;
}

/**
 * One `<system-reminder>` wrap spread over `paragraphs` (the first starts
 * with the open tag, the last ends with the close tag), without its
 * environment paragraphs; null when all it held were those.
 */
function stripWrap(
	paragraphs: string[],
	separators: string[],
	owned: (path: string) => boolean,
): string | null {
	const joined = paragraphs
		.map((p, k) => (k === 0 ? p : (separators[k] ?? "") + p))
		.join("");
	const openTag = OPEN.exec(paragraphs[0] ?? "")?.[0] ?? "";
	const lastRaw =
		paragraphs.length === 1
			? (paragraphs[0] ?? "").slice(openTag.length)
			: (paragraphs.at(-1) ?? "");
	const closeTag = CLOSE.exec(lastRaw)?.[0] ?? "";
	const cores = paragraphs.map((p, k) => {
		let text = k === 0 ? p.slice(openTag.length) : p;
		if (k === paragraphs.length - 1)
			text = text.slice(0, text.length - closeTag.length);
		return { before: k === 0 ? "" : (separators[k] ?? ""), text };
	});
	if (!cores.some((c) => isBlock(c.text, owned))) return joined;
	const kept = cores.filter(
		(c) => c.text.trim() !== "" && !isBlock(c.text, owned),
	);
	if (kept.length === 0) return null;
	const newline = openTag.endsWith("\r\n") ? "\r\n" : "\n";
	const close = /^\r?\n/.test(closeTag) ? closeTag : newline + closeTag;
	return (
		openTag +
		kept.map((c, k) => (k === 0 ? c.text : c.before + c.text)).join("") +
		close
	);
}

/**
 * `text` without the environment paragraphs. A paragraph inside a
 * `<system-reminder>` wrap is Claude Code's in any message; a bare one only
 * in a `role: "system"` message.
 */
function stripText(
	text: string,
	bareAllowed: boolean,
	owned: (path: string) => boolean,
): string {
	if (!MARKERS.some((m) => text.includes(m))) return text;
	const pieces = text.split(SEPARATOR);
	const paragraphs: string[] = [];
	const separators: string[] = [""];
	for (let i = 0; i < pieces.length; i += 2) {
		paragraphs.push(pieces[i] ?? "");
		if (i + 1 < pieces.length) separators.push(pieces[i + 1] ?? "");
	}
	const units: Unit[] = [];
	let removedAny = false;
	let i = 0;
	while (i < paragraphs.length) {
		const first = paragraphs[i] ?? "";
		const open = OPEN.exec(first);
		let end = -1;
		if (open)
			for (let j = i; j < paragraphs.length; j++) {
				const p = j === i ? first.slice(open[0].length) : paragraphs[j];
				if (CLOSE.test(p ?? "")) {
					end = j;
					break;
				}
			}
		if (end < 0) {
			const removed = bareAllowed && isBlock(first, owned);
			removedAny ||= removed;
			units.push({ before: separators[i] ?? "", text: first, removed });
			i++;
			continue;
		}
		const joined = paragraphs
			.slice(i, end + 1)
			.map((p, k) => (k === 0 ? p : (separators[i + k] ?? "") + p))
			.join("");
		const stripped = stripWrap(
			paragraphs.slice(i, end + 1),
			separators.slice(i, end + 1).map((s, k) => (k === 0 ? "" : s)),
			owned,
		);
		removedAny ||= stripped !== joined;
		units.push({
			before: separators[i] ?? "",
			text: stripped ?? "",
			removed: stripped === null,
		});
		i = end + 1;
	}
	if (!removedAny) return text;
	return units
		.filter((u) => !u.removed)
		.map((u, k) => (k === 0 ? u.text : u.before + u.text))
		.join("");
}

/** Block types that may carry a cache breakpoint. */
const BREAKPOINT_TYPES = new Set([
	"text",
	"image",
	"document",
	"tool_use",
	"tool_result",
]);

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `block` may take a moved breakpoint; null ends the search. */
function takesBreakpoint(block: unknown): boolean | null {
	if (!isObject(block)) return false;
	if (block.cache_control !== undefined) return null;
	if (!BREAKPOINT_TYPES.has(String(block.type))) return false;
	return !(block.type === "text" && !block.text);
}

/**
 * Put `cacheControl` on the nearest block before `blocks[upTo]` that can
 * take it: in `blocks`, then in the block-form messages of `kept`, latest
 * first. Thinking, empty text and string messages are passed over; a block
 * that already has a breakpoint ends the search, as does the start. Blocks
 * are replaced, never changed in place.
 */
function moveBreakpoint(
	cacheControl: unknown,
	blocks: unknown[],
	upTo: number,
	kept: Json[],
): void {
	for (let b = upTo - 1; b >= 0; b--) {
		const verdict = takesBreakpoint(blocks[b]);
		if (verdict === null) return;
		if (verdict) {
			blocks[b] = { ...(blocks[b] as Json), cache_control: cacheControl };
			return;
		}
	}
	for (let m = kept.length - 1; m >= 0; m--) {
		const message = kept[m] as Json;
		if (!Array.isArray(message.content)) continue;
		const content = message.content;
		for (let b = content.length - 1; b >= 0; b--) {
			const verdict = takesBreakpoint(content[b]);
			if (verdict === null) return;
			if (verdict) {
				const copy = [...content];
				copy[b] = { ...(content[b] as Json), cache_control: cacheControl };
				kept[m] = { ...message, content: copy };
				return;
			}
		}
	}
}

/** Whether a text left in place still looks like a block under a root. */
function looksLikeBlock(text: string, roots: readonly string[]): boolean {
	return (
		MARKERS.some((m) => text.includes(m)) &&
		roots.some((root) => text.includes(root))
	);
}

interface Pass {
	messages: Json[];
	changed: boolean;
	drift: boolean;
	keptInUserMessages: number;
	/** Indexes of the system messages dropped, ascending. */
	dropped: number[];
}

/** One pass over `messages`, leaving the messages at `keep` as they are. */
function stripMessages(
	messages: unknown[],
	owned: (path: string) => boolean,
	roots: readonly string[],
	keep: ReadonlySet<number>,
): Pass {
	const pass: Pass = {
		messages: [],
		changed: false,
		drift: false,
		keptInUserMessages: 0,
		dropped: [],
	};
	const kept = pass.messages;
	const strip = (text: string, system: boolean) => {
		const out = stripText(text, system, owned);
		if (looksLikeBlock(out, roots)) pass.drift = true;
		return out;
	};
	messages.forEach((message, index) => {
		if (
			!isObject(message) ||
			keep.has(index) ||
			(message.role !== "system" && message.role !== "user")
		) {
			kept.push(message as Json);
			return;
		}
		const system = message.role === "system";
		if (typeof message.content === "string") {
			const text = strip(message.content, system);
			if (text === message.content) kept.push(message);
			else if (text !== "") {
				pass.changed = true;
				kept.push({ ...message, content: text });
			} else if (system) {
				pass.changed = true;
				pass.dropped.push(index);
			} else {
				pass.keptInUserMessages++;
				kept.push(message);
			}
			return;
		}
		if (!Array.isArray(message.content)) {
			kept.push(message);
			return;
		}
		const blocks: unknown[] = [];
		const moves: Array<{ at: number; cacheControl: unknown }> = [];
		let removed = false;
		for (const block of message.content) {
			if (
				!isObject(block) ||
				block.type !== "text" ||
				typeof block.text !== "string"
			) {
				blocks.push(block);
				continue;
			}
			const text = strip(block.text, system);
			if (text === block.text) blocks.push(block);
			else {
				removed = true;
				if (text !== "") blocks.push({ ...block, text });
				else if (block.cache_control !== undefined)
					moves.push({ at: blocks.length, cacheControl: block.cache_control });
			}
		}
		if (!removed) {
			kept.push(message);
			return;
		}
		if (blocks.length === 0 && !system) {
			pass.keptInUserMessages++;
			kept.push(message);
			return;
		}
		pass.changed = true;
		for (const move of moves)
			moveBreakpoint(move.cacheControl, blocks, move.at, kept);
		if (blocks.length === 0) pass.dropped.push(index);
		else kept.push({ ...message, content: blocks });
	});
	return pass;
}

/**
 * Remove Claude Code's environment block from a Messages API body (a
 * `/v1/messages` or `/v1/messages/count_tokens` call), in place. Only
 * system messages are ever dropped, and never so that the request would
 * end on an assistant turn or hold no messages; a user message the block
 * would empty keeps it. An emptied block's cache breakpoint moves to the
 * nearest earlier block that can take it.
 */
export function stripEnvironmentBlocks(
	body: unknown,
	options: EnvironmentStripOptions,
): EnvironmentStripResult {
	if (!isObject(body) || !Array.isArray(body.messages))
		return { changed: false, drift: false, keptInUserMessages: 0 };
	const owned = sandboxMatcher(options.roots);
	const keep = new Set<number>();
	for (;;) {
		const pass = stripMessages(body.messages, owned, options.roots, keep);
		const ending = pass.messages.at(-1);
		if (
			pass.dropped.length > 0 &&
			(ending === undefined || ending.role === "assistant")
		) {
			keep.add(pass.dropped.at(-1) as number);
			continue;
		}
		if (pass.changed) body.messages = pass.messages;
		return {
			changed: pass.changed,
			drift: pass.drift,
			keptInUserMessages: pass.keptInUserMessages,
		};
	}
}
