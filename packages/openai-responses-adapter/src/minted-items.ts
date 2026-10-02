/**
 * Output items this adapter mints for replies a non-OpenAI model served. A
 * client replays them in later input, where only the id shape tells them apart
 * from OpenAI's own:
 *
 *   resp_0123456789abcdef01234567_msg_1   minted here
 *   msg_68a1…                             issued by OpenAI
 */
export type MintedItemKind = "msg" | "fc" | "ws" | "rs";

export function mintedItemId(
	responseId: string,
	kind: MintedItemKind,
	outputIndex: number,
): string {
	return `${responseId}_${kind}_${outputIndex}`;
}

const MINTED_ID = /^resp_[0-9a-f]{24}_(msg|fc|ws|rs)_\d+$/;

/**
 * One replayed input item as a native account may receive it, or null when it
 * must be left out. OpenAI rejects item ids it never issued
 * (`Expected an ID that begins with 'msg'`):
 *
 *   minted message                                 sent without its id or status
 *   minted function_call / custom_tool_call        sent without its id
 *   minted web_search_call                         left out
 *   minted reasoning without encrypted_content     left out
 *
 * Everything else is returned as the same object.
 */
export function nativeInputItem(item: unknown): unknown {
	if (!item || typeof item !== "object") return item;
	const { id, ...rest } = item as Record<string, unknown>;
	const kind = typeof id === "string" ? MINTED_ID.exec(id)?.[1] : undefined;
	if (!kind) return item;
	if (kind === "ws") return null;
	if (kind === "rs") return rest.encrypted_content == null ? null : item;
	if (kind === "msg") {
		const { status: _status, ...message } = rest;
		return message;
	}
	return rest;
}
