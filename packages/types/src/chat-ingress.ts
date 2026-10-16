/** A Chat request field that not every destination can honor. */
export type ChatField =
	| "max_tokens"
	| "temperature"
	| "top_p"
	| "stop"
	| "reasoning_content"
	| "response_format";
/** In-process Chat ingress context. Client headers cannot create or replace it. */
export interface ChatRequirements {
	readonly fields: readonly ChatField[];
}
/**
 * What a Chat `json_schema` response_format carries beyond the schema, which
 * travels in the Messages body as `output_config.format`.
 */
export interface ChatStructuredOutput {
	readonly name: string;
	readonly description?: string;
	readonly strict: boolean;
}
export interface ChatIngressContext {
	readonly requirements: ChatRequirements;
	readonly structuredOutput?: ChatStructuredOutput;
	readonly defaultMaxTokens: number;
	/** See NativeResponsesContext.denyDirectOfficialAnthropic. */
	readonly denyDirectOfficialAnthropic?: boolean;
	outgoingModel?: string;
	provider?: string;
	reportedModel?: string;
	usageObserved?: boolean;
}
const contexts = new WeakMap<object, ChatIngressContext>();
export function setChatContext(
	owner: object,
	context: ChatIngressContext,
): void {
	contexts.set(owner, context);
}
export function getChatContext(owner: object): ChatIngressContext | undefined {
	return contexts.get(owner);
}
export function transferChatContext(from: object, to: object): void {
	const context = getChatContext(from);
	if (context) setChatContext(to, context);
}
