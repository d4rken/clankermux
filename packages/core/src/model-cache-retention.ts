import type { ModelCacheRetention } from "@clankermux/types";
import {
	type ModelCachePolicyRoute,
	resolveModelCachePolicy,
} from "./model-cache-policy";
import { parseCustomEndpointData } from "./model-mappings";

const SOURCES = {
	openai: "https://developers.openai.com/api/docs/guides/prompt-caching",
	anthropic:
		"https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
	openrouter: "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
	minimax:
		"https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache",
	dashscope: "https://www.alibabacloud.com/help/en/model-studio/context-cache",
	groq: "https://console.groq.com/docs/prompt-caching",
	deepseek: "https://api-docs.deepseek.com/guides/kv_cache",
} as const;

function heuristic(): ModelCacheRetention {
	return {
		basis: "heuristic",
		retentionMs: 300_000,
		semantics: "heuristic",
		confidence: "low",
		anchor: "request_start",
		anchorBasis: "assumed",
		refreshOnReuse: true,
		refreshBasis: "assumed",
		sources: [],
		note: "Gateway display heuristic of five minutes. No numeric retention evidence applies; caching itself may be unavailable. Request-start timing and refresh on reuse are assumptions. Elapsed time means warmth is uncertain, not that the cache expired.",
	};
}

function estimate(
	retentionMs: number,
	source: keyof typeof SOURCES,
	note: string,
	options: Partial<ModelCacheRetention> = {},
): ModelCacheRetention {
	return {
		basis: "documented",
		retentionMs,
		semantics: "configured",
		confidence: "medium",
		anchor: "request_start",
		anchorBasis: "assumed",
		refreshOnReuse: true,
		refreshBasis: "documented",
		sources: [{ url: SOURCES[source], note }],
		note: `${note} Request start is an assumed conservative timing anchor unless marked documented. This advisory window does not guarantee a cache hit or prove expiry.`,
		...options,
	};
}

function routeRetention(
	model: string,
	route: ModelCachePolicyRoute,
): ModelCacheRetention {
	const policy = resolveModelCachePolicy(model, [route]);
	if (!policy || policy.source !== "gateway-policy") return heuristic();
	// The verified resolver has already checked the actual adapter endpoint and model scope.
	const endpoint =
		route.provider === "openai-compatible"
			? parseCustomEndpointData(
					route.customEndpoint ?? "https://api.openai.com",
				)?.endpoint
			: [
						"anthropic",
						"claude-console-api",
						"anthropic-compatible",
						"codex",
						"openrouter",
					].includes(route.provider)
				? route.customEndpoint
				: undefined;
	let hostname = "";
	try {
		hostname = endpoint ? new URL(endpoint).hostname : "";
	} catch {
		/* Fixed adapters may ignore custom configuration. */
	}
	const router =
		route.provider === "openrouter" || hostname === "openrouter.ai";
	const codexSubscription =
		route.provider === "codex" && hostname !== "api.openai.com";
	const openai =
		codexSubscription ||
		hostname === "api.openai.com" ||
		(route.provider === "openai-compatible" && !route.customEndpoint) ||
		(router && model.startsWith("openai/"));
	if (openai) {
		const modern =
			policy.defaultTtlMs === 1_800_000 ||
			/^gpt-(?:5\.6(?:-|$)|6-(?:astra|sol|luna)(?:-|$))/.test(model);
		const note = modern
			? "OpenAI documents a 30-minute minimum after the latest cache write or reuse for GPT-5.6 and later."
			: "OpenAI documents typical inactive in-memory retention of five to ten minutes for earlier models; account settings and retention options can differ.";
		const value = estimate(modern ? 1_800_000 : 300_000, "openai", note, {
			semantics: modern ? "minimum" : "typical",
			...(modern
				? {}
				: { typicalRangeMs: [300_000, 600_000] as [number, number] }),
		});
		if (router)
			value.sources.push({
				url: SOURCES.openrouter,
				note: "OpenRouter documents forwarding model-specific caching behavior; backend selection can change retention.",
			});
		if (codexSubscription) {
			value.basis = "inferred";
			value.confidence = "low";
			value.refreshBasis = "assumed";
			value.note = `API retention borrowed for the Codex subscription backend; applicability and refresh behavior are unverified. ${value.note}`;
		}
		return value;
	}
	if (policy.defaultTtlMs !== undefined) {
		const source = router
			? "openrouter"
			: route.provider === "minimax" || hostname === "api.minimax.io"
				? "minimax"
				: hostname === "api.groq.com"
					? "groq"
					: hostname.endsWith(".aliyuncs.com")
						? "dashscope"
						: "anthropic";
		const note =
			source === "groq"
				? "Groq documents two hours of inactivity for supported GPT-OSS models."
				: source === "anthropic"
					? "Anthropic documents five-minute caching refreshed from request start on reuse; gateway promotion can retain entries longer."
					: "The documented explicit cache default is five minutes and reuse refreshes retention; request options can retain entries longer.";
		return estimate(policy.defaultTtlMs, source, note, {
			semantics: policy.ttlSemantics === "minimum" ? "minimum" : "configured",
			anchorBasis:
				policy.ttlAnchor === "request_start" ? "documented" : "assumed",
			confidence: policy.ttlAnchor === "request_start" ? "high" : "medium",
		});
	}
	if (
		(router && model.startsWith("google/gemini-")) ||
		hostname === "generativelanguage.googleapis.com"
	) {
		const value = estimate(
			180_000,
			"openrouter",
			"OpenRouter describes typical implicit Gemini retention of three to five minutes; load and prefix matching affect reuse.",
			{
				semantics: "typical",
				typicalRangeMs: [180_000, 300_000],
				refreshBasis: "assumed",
			},
		);
		if (!router) {
			value.basis = "inferred";
			value.confidence = "low";
			value.note = `Direct Gemini borrows OpenRouter's reported behavior; applicability and refresh behavior are unverified. ${value.note}`;
		}
		return value;
	}
	if (
		hostname === "api.deepseek.com" ||
		(router && model.startsWith("deepseek/"))
	) {
		return estimate(
			3_600_000,
			"deepseek",
			"DeepSeek describes unused entries being cleared after hours to days without a fixed lifetime. One hour is a conservative interpretation, not a documented minimum; reuse refresh is assumed.",
			{
				basis: "inferred",
				semantics: "typical",
				confidence: "low",
				refreshBasis: "assumed",
			},
		);
	}
	return heuristic();
}

/** Display advice stays separate from policy, including when no route can be substantiated. */
export function resolveModelCacheRetention(
	targetModel: string,
	routes: ModelCachePolicyRoute[],
	unresolvedRoutes = false,
): ModelCacheRetention {
	if (unresolvedRoutes || !routes.length) return heuristic();
	return reduceModelCacheRetentions(
		routes.map((route) => routeRetention(targetModel, route)),
	);
}

export function reduceModelCacheRetentions(
	candidates: Array<ModelCacheRetention | undefined>,
): ModelCacheRetention {
	if (!candidates.length) return heuristic();
	const values = candidates.map((candidate) => candidate ?? heuristic());
	const first = values[0];
	if (values.every((value) => JSON.stringify(value) === JSON.stringify(first)))
		return first;
	const weakest = values.some((value) => value.basis === "heuristic")
		? "heuristic"
		: "inferred";
	const sources = [
		...new Map(
			values
				.flatMap((value) => value.sources)
				.map((source) => [JSON.stringify(source), source]),
		).values(),
	].sort((a, b) => a.url.localeCompare(b.url) || a.note.localeCompare(b.note));
	return {
		basis: weakest,
		retentionMs: Math.min(...values.map((value) => value.retentionMs)),
		semantics: weakest === "heuristic" ? "heuristic" : "typical",
		confidence: "low",
		anchor: "request_start",
		anchorBasis: "assumed",
		refreshOnReuse: values.every((value) => value.refreshOnReuse),
		refreshBasis: values.every((value) => value.refreshBasis === "documented")
			? "documented"
			: "assumed",
		sources,
		note: "Available retention evidence differs. This advisory window uses the shortest estimate with reduced confidence; source descriptions may not apply to every request. Request-start timing is assumed. Elapsed time means warmth is uncertain, not proven expiry.",
	};
}
