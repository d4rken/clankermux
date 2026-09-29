import type { SdkBridgeHostedWebSearch } from "@clankermux/types";
import type { ResponsesRequest, ResponsesTool } from "./types";

/** `web_search`, `web_search_preview` and their dated snapshots. */
const WEB_SEARCH_TYPE = /^web_search(_preview)?(_\d{4}_\d{2}_\d{2})?$/;
const HOSTNAME =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_ALLOWED_DOMAINS = 100;
const SOURCES_INCLUDE = "web_search_call.action.sources";

export function isHostedWebSearchTool(tool: { type?: unknown }): boolean {
	return typeof tool.type === "string" && WEB_SEARCH_TYPE.test(tool.type);
}

/**
 * What becomes of a request's hosted web search. Only a bridged Claude turn
 * can serve one, and only when it is the request's only tool; every other
 * destination drops it, as the translated body never carries it.
 */
export type HostedWebSearchPlan =
	| { kind: "absent" }
	| { kind: "invalid"; message: string }
	| { kind: "dropped"; toolType: string; reason: "mixed" | "tool_choice_none" }
	| {
			kind: "served";
			toolType: string;
			search: SdkBridgeHostedWebSearch;
			/** Hints the search takes no account of, by their Messages-side name. */
			droppedFields: string[];
	  };

function allToolsOf(body: ResponsesRequest): ResponsesTool[] {
	const tools = [...(body.tools ?? [])];
	if (Array.isArray(body.input))
		for (const item of body.input)
			if (item?.type === "additional_tools" && Array.isArray(item.tools))
				tools.push(...item.tools);
	return tools;
}

function requiredBy(choice: ResponsesRequest["tool_choice"]): boolean {
	if (choice === "required") return true;
	return (
		!!choice &&
		typeof choice === "object" &&
		isHostedWebSearchTool(choice as { type?: unknown })
	);
}

/**
 * `filters.allowed_domains` as plain lowercase hostnames, or why not.
 *
 *   ["Docs.Bun.sh", "bun.sh", "bun.sh"] → ["docs.bun.sh", "bun.sh"]
 *   ["https://bun.sh"] / ["bun.sh/docs"] / ["bun"] → refused
 */
function allowedDomainsOf(
	filters: unknown,
): { ok: true; domains: string[] | null } | { ok: false; message: string } {
	if (filters === undefined || filters === null)
		return { ok: true, domains: null };
	if (typeof filters !== "object" || Array.isArray(filters))
		return { ok: false, message: "web_search filters must be an object" };
	const raw = (filters as { allowed_domains?: unknown }).allowed_domains;
	if (raw === undefined || raw === null) return { ok: true, domains: null };
	if (!Array.isArray(raw))
		return {
			ok: false,
			message: "web_search filters.allowed_domains must be an array",
		};
	if (raw.length > MAX_ALLOWED_DOMAINS)
		return {
			ok: false,
			message: `web_search filters.allowed_domains takes at most ${MAX_ALLOWED_DOMAINS} domains`,
		};
	const domains: string[] = [];
	for (const entry of raw) {
		const domain = typeof entry === "string" ? entry.trim().toLowerCase() : "";
		if (!HOSTNAME.test(domain))
			return {
				ok: false,
				message: `web_search filters.allowed_domains entries must be plain hostnames without a scheme or path (got ${JSON.stringify(entry)})`,
			};
		if (!domains.includes(domain)) domains.push(domain);
	}
	return { ok: true, domains: domains.length ? domains : null };
}

export function planHostedWebSearch(
	body: ResponsesRequest,
): HostedWebSearchPlan {
	const tools = allToolsOf(body);
	const searches = tools.filter(isHostedWebSearchTool);
	const first = searches[0];
	if (!first) return { kind: "absent" };
	const toolType = String(first.type);
	if (tools.length > searches.length)
		return { kind: "dropped", toolType, reason: "mixed" };
	if (body.tool_choice === "none")
		return { kind: "dropped", toolType, reason: "tool_choice_none" };
	if (searches.some((s) => JSON.stringify(s) !== JSON.stringify(first)))
		return {
			kind: "invalid",
			message: "Only one web_search tool is supported per request",
		};
	const tool = first as Record<string, unknown>;
	const domains = allowedDomainsOf(tool.filters);
	if (!domains.ok) return { kind: "invalid", message: domains.message };
	return {
		kind: "served",
		toolType,
		search: {
			required: requiredBy(body.tool_choice),
			allowedDomains: domains.domains,
		},
		droppedFields: (["user_location", "search_context_size"] as const)
			.filter((field) => tool[field] != null)
			.map((field) => `web_search.${field}`),
	};
}

/** Whether the client asked for `web_search_call.action.sources`, as OpenAI gates them. */
export function includesWebSearchSources(body: ResponsesRequest): boolean {
	const include = (body as { include?: unknown }).include;
	return Array.isArray(include) && include.includes(SOURCES_INCLUDE);
}

export interface WebSearchSource {
	url: string;
	title?: string;
}

/** A `web_search_tool_result`'s content: its sources, or its error code. */
export function webSearchResultOf(
	content: unknown,
): { ok: true; sources: WebSearchSource[] } | { ok: false; errorCode: string } {
	if (!Array.isArray(content)) {
		const code = (content as { error_code?: unknown } | null)?.error_code;
		return {
			ok: false,
			errorCode: typeof code === "string" && code ? code : "unavailable",
		};
	}
	const sources: WebSearchSource[] = [];
	for (const entry of content as Array<Record<string, unknown>>) {
		if (entry?.type !== "web_search_result" || typeof entry.url !== "string")
			continue;
		sources.push({
			url: entry.url,
			...(typeof entry.title === "string" && entry.title
				? { title: entry.title }
				: {}),
		});
	}
	return { ok: true, sources };
}

/** The Responses `web_search_call` item a finished search becomes. */
export function webSearchCallItem(input: {
	id: string;
	query: string | null;
	status: "completed" | "failed";
	sources: WebSearchSource[];
	includeSources: boolean;
}): Record<string, unknown> {
	return {
		type: "web_search_call",
		id: input.id,
		status: input.status,
		action: {
			type: "search",
			...(input.query !== null ? { query: input.query } : {}),
			...(input.includeSources
				? {
						sources: input.sources.map((s) => ({
							type: "url",
							url: s.url,
							...(s.title ? { title: s.title } : {}),
						})),
					}
				: {}),
		},
	};
}

/** A server_tool_use input's query; null when it names none. */
export function webSearchQueryOf(input: unknown): string | null {
	const query = (input as { query?: unknown } | null)?.query;
	return typeof query === "string" ? query : null;
}

/** `web_search_result_location` citations as Responses `url_citation`s over `text`. */
export function urlCitationsOf(
	citations: unknown,
	text: string,
): Array<Record<string, unknown>> {
	if (!Array.isArray(citations)) return [];
	return citations.flatMap((c: Record<string, unknown>) =>
		c?.type === "web_search_result_location" && typeof c.url === "string"
			? [
					{
						type: "url_citation",
						url: c.url,
						title: typeof c.title === "string" ? c.title : "",
						start_index: 0,
						end_index: text.length,
					},
				]
			: [],
	);
}
