/** What the client's system prompt becomes on top of Claude Code's own. */
export interface SystemPromptDecision {
	/** Text appended to the claude_code preset; null sends the preset alone. */
	append: string | null;
	excludeDynamicSections: boolean;
}

export interface SystemPromptPolicyTurn {
	model: string;
	clientHarness: string | null;
}

export interface SystemPromptPolicy {
	/** Recorded on the turn row as `system_prompt_policy`. */
	readonly name: string;
	decide(
		clientSystem: string,
		turn: SystemPromptPolicyTurn,
	): SystemPromptDecision;
}

/**
 * Claude Code's preset alone; the client's system text is never sent. Stock
 * pi's prompt contains phrases that reproducibly draw a 400 "out of extra
 * usage" from subscription accounts.
 */
export const dropSystemPromptPolicy: SystemPromptPolicy = {
	name: "drop",
	decide: () => ({ append: null, excludeDynamicSections: false }),
};

const POLICIES: ReadonlyMap<string, SystemPromptPolicy> = new Map([
	[dropSystemPromptPolicy.name, dropSystemPromptPolicy],
]);

export function registeredSystemPromptPolicies(): string[] {
	return [...POLICIES.keys()];
}

export function getSystemPromptPolicy(name = "drop"): SystemPromptPolicy {
	const policy = POLICIES.get(name);
	if (!policy) throw new Error(`Unknown system prompt policy "${name}"`);
	return policy;
}
