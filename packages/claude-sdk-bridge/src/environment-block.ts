/**
 * Claude Code tells the model where it runs: a block naming its working
 * directory, platform, shell and OS, and an update block when any of them
 * changes. Under the bridge that is the child's private sandbox on the
 * ClankerMux host, never the client's machine, whose tools the model is
 * really driving. The block is removed from every model call; everything
 * else in the message that carries it stays as it was.
 *
 * The shapes are Claude Code's own renderings, pinned against the real
 * binary by "never shows the model Claude Code's own directories, only the
 * client's" in `real-claude.integration.test.ts`.
 */

type Json = Record<string, unknown>;

const LIST_LINE = String.raw` {1,2}- [^\n]*`;
const FULL = String.raw`# Environment\nYou have been invoked in the following environment: \n - Primary working directory: [^\n]*(?:\n${LIST_LINE})*`;
const UPDATE = String.raw`# Environment update(?:\n${LIST_LINE})+`;
const WRAPPED = new RegExp(
	String.raw`^<system-reminder>\n(?:${FULL}|${UPDATE})\n</system-reminder>$`,
);
const BARE = new RegExp(`^(?:${FULL}|${UPDATE})$`);

/** Blocks Claude Code writes, one per blank-line-separated paragraph. */
const SEPARATOR = "\n\n";

/**
 * `text` without its environment paragraphs. A `role: "system"` message
 * carries them bare or wrapped in `<system-reminder>`; a user message only
 * wrapped, since its bare text may be the client's.
 */
function stripText(text: string, bareAllowed: boolean): string {
	if (!text.includes("# Environment")) return text;
	const kept = text
		.split(SEPARATOR)
		.filter(
			(paragraph) =>
				!WRAPPED.test(paragraph) && !(bareAllowed && BARE.test(paragraph)),
		);
	return kept.join(SEPARATOR);
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

/**
 * Put `cacheControl` on the last block before the removed one: the last
 * block of `blocks`, or else of the last message in `kept`. A block that
 * cannot carry one, or already carries one, keeps what it has.
 */
function moveBreakpoint(
	cacheControl: unknown,
	blocks: unknown[],
	kept: Json[],
): void {
	let target: Json | undefined;
	const last = blocks.at(-1);
	if (isObject(last)) target = last;
	else if (blocks.length === 0) {
		const previous = kept.at(-1);
		if (previous && typeof previous.content === "string")
			previous.content = [{ type: "text", text: previous.content }];
		const content = previous?.content;
		const end = Array.isArray(content) ? content.at(-1) : undefined;
		if (isObject(end)) target = end;
	}
	if (
		!target ||
		target.cache_control !== undefined ||
		!BREAKPOINT_TYPES.has(String(target.type))
	)
		return;
	target.cache_control = cacheControl;
}

/**
 * Remove Claude Code's environment block from a Messages API body (a
 * `/v1/messages` or `/v1/messages/count_tokens` call), in place. A text
 * block or message left empty goes, and its cache breakpoint moves to the
 * block before it. Returns whether anything changed.
 */
export function stripEnvironmentBlocks(body: unknown): boolean {
	if (!isObject(body) || !Array.isArray(body.messages)) return false;
	let changed = false;
	const kept: Json[] = [];
	for (const message of body.messages) {
		if (!isObject(message)) {
			kept.push(message as Json);
			continue;
		}
		const bareAllowed = message.role === "system";
		if (bareAllowed || message.role === "user") {
			if (typeof message.content === "string") {
				const text = stripText(message.content, bareAllowed);
				if (text !== message.content) {
					changed = true;
					if (text === "") continue;
					message.content = text;
				}
			} else if (Array.isArray(message.content)) {
				const blocks: unknown[] = [];
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
					const text = stripText(block.text, bareAllowed);
					if (text === block.text) {
						blocks.push(block);
						continue;
					}
					removed = true;
					if (text !== "") {
						blocks.push({ ...block, text });
						continue;
					}
					if (block.cache_control !== undefined)
						moveBreakpoint(block.cache_control, blocks, kept);
				}
				if (removed) {
					changed = true;
					if (blocks.length === 0) continue;
					message.content = blocks;
				}
			}
		}
		kept.push(message);
	}
	if (changed) body.messages = kept;
	return changed;
}
