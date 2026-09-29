import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/** Claude Code's own web search tool. */
export const WEB_SEARCH_TOOL = "WebSearch";

/** The error codes of Anthropic's `web_search_tool_result_error`. */
const ERROR_CODES = new Set([
	"invalid_tool_input",
	"unavailable",
	"max_uses_exceeded",
	"too_many_requests",
	"query_too_long",
	"request_too_large",
]);
/** How Claude Code renders a search's error among its results. */
const SEARCH_ERROR = /^Web search error: (\S+)/;

export interface WebSearchSource {
	url: string;
	title: string;
}

/** One WebSearch call as the client sees it, from Claude Code's report of it. */
export type WebSearchOutcome =
	| { status: "completed"; sources: WebSearchSource[]; searchCount: number }
	| { status: "failed"; errorCode: string; searchCount: number };

function failed(errorCode: string, searchCount = 0): WebSearchOutcome {
	return {
		status: "failed",
		errorCode: ERROR_CODES.has(errorCode) ? errorCode : "unavailable",
		searchCount,
	};
}

/**
 * A WebSearch call's outcome from Claude Code's `tool_use_result`, a
 * `WebSearchOutput`: `results` holds one group per search the model made
 * (`{tool_use_id, content: [{title, url}]}`) and its text commentary.
 *
 *   groups, any URLs or none          → completed, their URLs once each
 *   "Web search error: <code>" only   → failed with that code
 *   commentary only, searchCount 0    → failed: no search was made
 *   is_error, no or invalid output    → failed
 */
export function webSearchOutcome(
	output: unknown,
	isError: boolean,
): WebSearchOutcome {
	if (isError || !output || typeof output !== "object") return failed("");
	const { query, results, searchCount } = output as Record<string, unknown>;
	if (typeof query !== "string" || !Array.isArray(results)) return failed("");
	const count =
		typeof searchCount === "number" && Number.isFinite(searchCount)
			? searchCount
			: 0;
	const groups = results.filter(
		(r): r is { content: unknown[] } =>
			!!r &&
			typeof r === "object" &&
			Array.isArray((r as { content?: unknown }).content),
	);
	if (groups.length) {
		const sources: WebSearchSource[] = [];
		for (const hit of groups.flatMap((g) => g.content)) {
			const { url, title } = (hit ?? {}) as Record<string, unknown>;
			if (typeof url !== "string" || sources.some((s) => s.url === url))
				continue;
			sources.push({ url, title: typeof title === "string" ? title : "" });
		}
		return { status: "completed", sources, searchCount: count };
	}
	for (const entry of results)
		if (typeof entry === "string") {
			const code = SEARCH_ERROR.exec(entry)?.[1];
			if (code) return failed(code, count);
		}
	return count > 0
		? { status: "completed", sources: [], searchCount: count }
		: failed("");
}

/** A domain as a filter entry names it: lowercase, no trailing dot. */
function normalizeDomain(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const domain = value.trim().toLowerCase().replace(/\.$/, "");
	return /^[a-z0-9.-]+$/.test(domain) && domain.includes(".") ? domain : null;
}

function within(domain: string, allowed: readonly string[]): boolean {
	return allowed.some((a) => domain === a || domain.endsWith(`.${a}`));
}

/**
 * The input a WebSearch call runs with under the client's domain filter, or
 * why it may not run. The model may narrow the filter, never widen or drop
 * it; a blocked list goes, since the search takes one list or the other.
 *
 *   filter [bun.sh]: {query}                           → {query, allowed_domains: [bun.sh]}
 *                    {query, allowed_domains: [docs.bun.sh]} → kept
 *                    {query, allowed_domains: [evil.test]}   → refused
 */
export function constrainWebSearchInput(
	input: Record<string, unknown>,
	allowed: readonly string[],
):
	| { ok: true; input: Record<string, unknown> }
	| { ok: false; reason: string } {
	const { blocked_domains: _blocked, allowed_domains: asked, ...rest } = input;
	if (asked === undefined || asked === null)
		return { ok: true, input: { ...rest, allowed_domains: [...allowed] } };
	const requested = Array.isArray(asked) ? asked.map(normalizeDomain) : null;
	if (
		!requested?.length ||
		requested.some((d) => d === null || !within(d, allowed))
	)
		return {
			ok: false,
			reason: `Web search is limited to ${allowed.join(", ")}; search within those domains only`,
		};
	return {
		ok: true,
		input: { ...rest, allowed_domains: requested as string[] },
	};
}

/** The PreToolUse hook holding every WebSearch call to the client's filter. */
export function webSearchDomainHook(allowed: readonly string[]): HookCallback {
	return async (hookInput) => {
		const toolInput = ((hookInput as { tool_input?: unknown }).tool_input ??
			{}) as Record<string, unknown>;
		const decided = constrainWebSearchInput(toolInput, allowed);
		return {
			hookSpecificOutput: decided.ok
				? {
						hookEventName: "PreToolUse",
						permissionDecision: "allow",
						updatedInput: decided.input,
					}
				: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: decided.reason,
					},
		};
	};
}
