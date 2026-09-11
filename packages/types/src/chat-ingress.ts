/** In-process Chat ingress context. Client headers cannot create or replace it. */
export interface ChatRequirements {
	readonly fields: readonly string[];
}
export interface ChatIngressContext {
	readonly requirements: ChatRequirements;
	readonly defaultMaxTokens: number;
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
