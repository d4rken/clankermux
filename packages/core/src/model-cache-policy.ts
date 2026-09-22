import type {
	ClientFormat,
	ModelCachePolicy,
	ProviderName,
} from "@clankermux/types";
import { isKnownProvider } from "@clankermux/types";
import { parseCustomEndpointData } from "./model-mappings";
import { CLAUDE_MODEL_IDS, stripDatedModelSuffix } from "./models";

export interface ModelCachePolicyRoute {
	provider: string;
	customEndpoint?: string | null;
	format: ClientFormat;
}

const UNKNOWN: ModelCachePolicy = {
	mode: "unknown",
	expiry: "unavailable",
	source: "unknown",
};
const IMPLICIT: ModelCachePolicy = {
	mode: "implicit",
	expiry: "unavailable",
	source: "gateway-policy",
};
const ANTHROPIC: ModelCachePolicy = {
	mode: "explicit",
	defaultTtlMs: 300_000,
	supportedTtlMs: [300_000, 3_600_000],
	refreshOnReuse: true,
	expiry: "estimated",
	source: "gateway-policy",
	ttlAnchor: "request_start",
	ttlSemantics: "minimum",
};

const CLAUDE_MODELS = new Set(
	Object.values(CLAUDE_MODEL_IDS).flatMap((id) => [
		id,
		id.replace(/-\d{8}$/, ""),
	]),
);
const MODERN_OPENAI =
	/^gpt-(?:5\.6(?:-(?:sol|terra|luna))?|6-(?:astra|sol|luna))$/;
const EARLIER_OPENAI =
	/^(?:gpt-(?:4o(?:-mini)?|4\.1(?:-mini|-nano)?|5(?:\.[1-5])?(?:-(?:pro|mini|nano|codex(?:-max|-mini)?|chat-latest))?)|o[134](?:-mini|-pro|-preview)?)$/;

function claudeModel(model: string): boolean {
	return CLAUDE_MODELS.has(model.replace(/-latest$/, ""));
}

function openaiPolicy(model: string): ModelCachePolicy {
	const base = stripDatedModelSuffix(model) ?? model;
	if (MODERN_OPENAI.test(base))
		return {
			...IMPLICIT,
			defaultTtlMs: 1_800_000,
			refreshOnReuse: true,
			ttlAnchor: "unknown",
			ttlSemantics: "minimum",
		};
	if (EARLIER_OPENAI.test(base))
		return { ...IMPLICIT, refreshOnReuse: true, ttlSemantics: "typical" };
	return UNKNOWN;
}

// Match origin AND base path: a protocol-compatible proxy cannot inherit a vendor's contract.
function officialEndpoint(
	endpoint: string,
	origin: string,
	paths: string[],
): boolean {
	try {
		const url = new URL(endpoint);
		return (
			url.origin === origin &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			paths.includes(url.pathname.replace(/\/$/, ""))
		);
	} catch {
		return false;
	}
}

function anthropicPolicy(
	model: string,
	format: ClientFormat,
): ModelCachePolicy {
	return claudeModel(model) && format === "anthropic" ? ANTHROPIC : UNKNOWN;
}

function openrouterPolicy(
	model: string,
	format: ClientFormat,
): ModelCachePolicy {
	if (model.startsWith("anthropic/") && claudeModel(model.slice(10))) {
		if (format !== "anthropic") return UNKNOWN;
		// OpenRouter specifies TTL choices across Claude backends, but not a common timestamp anchor.
		return { ...ANTHROPIC, expiry: "unavailable", ttlAnchor: "unknown" };
	}
	if (model.startsWith("openai/")) return openaiPolicy(model.slice(7));
	if (model.startsWith("z-ai/")) return glmPolicy(model.slice(5));
	if (model.startsWith("x-ai/")) return grokPolicy(model.slice(5));
	if (
		/^(?:deepseek\/deepseek-(?:chat|reasoner|v\d|r1)|moonshotai\/kimi-k)/.test(
			model,
		)
	)
		return IMPLICIT;
	if (/^google\/gemini-(?:2\.5|3(?:\.\d+)?)-/.test(model))
		return { ...IMPLICIT, ttlSemantics: "typical" };
	if (
		format === "anthropic" &&
		[
			"qwen/qwen3-max",
			"qwen/qwen-plus",
			"qwen/qwen3.6-plus",
			"qwen/qwen3-coder-plus",
			"qwen/qwen3-coder-flash",
		].includes(model)
	) {
		return {
			mode: "explicit",
			expiry: "unavailable",
			source: "gateway-policy",
		};
	}
	return UNKNOWN;
}

type RouteResolver = (
	model: string,
	route: ModelCachePolicyRoute,
) => ModelCachePolicy;

const DASHSCOPE_IMPLICIT_MODELS = new Set([
	"qwen3.8-max",
	"qwen3.8-max-0902",
	"qwen3.7-max",
	"qwen3.7-max-2026-05-20",
	"qwen3.7-max-2026-06-08",
	"qwen3-max",
	"qwen3-max-preview",
	"qwen-max",
	"qwen3.7-plus",
	"qwen3.7-plus-2026-05-26",
	"qwen-plus",
	"qwen3.8-flash",
	"qwen3.7-flash",
	"qwen3.7-flash-2026-07-15",
	"qwen-flash",
	"qwen-turbo",
	"qwen3-coder-plus",
	"qwen3-coder-flash",
	"qwen-plus-character",
	"qwen-flash-character",
	"qwen3.8-2.4t-a95b",
	"qwen3.8-27b",
	"qwen3-vl-plus",
	"qwen3-vl-flash",
	"qwen-vl-max",
	"qwen-vl-plus",
	"qwen3.8-omni-flash",
	"deepseek-v4.1-flash",
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"deepseek-v3.2",
	"glm-5.3",
	"glm-5.1",
	"kimi-k3",
	"kimi-k2.7-code",
]);

const DASHSCOPE_BEIJING_EXPLICIT_QWEN = new Set([
	"qwen3.8-max",
	"qwen3.8-max-0902",
	"qwen3.7-max",
	"qwen3.7-max-2026-05-20",
	"qwen3.7-max-2026-06-08",
	"qwen3.6-max-preview",
	"qwen3-max",
	"qwen3.8-2.4t-a95b",
	"qwen3.8-27b",
	"qwen3.7-plus",
	"qwen3.7-plus-2026-05-26",
	"qwen3.6-plus",
	"qwen3.5-plus",
	"qwen3.5-plus-2026-04-20",
	"qwen-plus",
	"qwen3.8-flash",
	"qwen3.7-flash",
	"qwen3.7-flash-2026-07-15",
	"qwen3.6-flash",
	"qwen3.5-flash",
	"qwen-flash",
	"qwen3-coder-plus",
	"qwen3-coder-flash",
	"qwen3-vl-plus",
	"qwen3-vl-flash",
]);

function compatiblePolicy(
	model: string,
	endpoint: string,
	format: ClientFormat,
): ModelCachePolicy {
	if (
		officialEndpoint(endpoint, "https://dashscope.aliyuncs.com", [
			"/compatible-mode/v1",
		]) &&
		model.toLowerCase().includes("qwen")
	) {
		// alibaba.test.ts pins this policy to the adapter's injected breakpoints.
		return DASHSCOPE_BEIJING_EXPLICIT_QWEN.has(model)
			? {
					mode: "explicit",
					defaultTtlMs: 300_000,
					refreshOnReuse: true,
					expiry: "unavailable",
					source: "gateway-policy",
					ttlAnchor: "unknown",
					ttlSemantics: "configured",
				}
			: UNKNOWN;
	}
	if (officialEndpoint(endpoint, "https://api.openai.com", ["", "/v1"]))
		return openaiPolicy(model);
	if (officialEndpoint(endpoint, "https://openrouter.ai", ["/api/v1"]))
		return openrouterPolicy(model, format);
	if (
		officialEndpoint(endpoint, "https://api.deepseek.com", ["", "/v1"]) &&
		/^deepseek-(?:chat|reasoner|v\d|r1)/i.test(model)
	)
		return IMPLICIT;
	if (
		officialEndpoint(endpoint, "https://api.moonshot.ai", ["", "/v1"]) &&
		/^(?:kimi-|moonshot-)/i.test(model)
	)
		return IMPLICIT;
	if (officialEndpoint(endpoint, "https://api.x.ai", ["", "/v1"]))
		return grokPolicy(model);
	if (
		officialEndpoint(endpoint, "https://api.z.ai", [
			"/api/paas/v4",
			"/api/coding/paas/v4",
		])
	)
		return glmPolicy(model);
	if (
		officialEndpoint(endpoint, "https://api.minimax.io", ["", "/v1"]) &&
		/^MiniMax-M(?:2\.[157]|3)(?:-highspeed)?$/i.test(model)
	)
		return IMPLICIT;
	if (
		officialEndpoint(endpoint, "https://api.groq.com", ["/openai/v1"]) &&
		[
			"openai/gpt-oss-20b",
			"openai/gpt-oss-120b",
			"openai/gpt-oss-safeguard-20b",
		].includes(model)
	)
		return {
			...IMPLICIT,
			defaultTtlMs: 7_200_000,
			refreshOnReuse: true,
			ttlAnchor: "unknown",
			ttlSemantics: "configured",
		};
	if (
		officialEndpoint(endpoint, "https://generativelanguage.googleapis.com", [
			"/v1beta/openai",
		]) &&
		/^gemini-(?:2\.5|3(?:\.\d+)?)-/.test(model)
	)
		return IMPLICIT;
	if (DASHSCOPE_IMPLICIT_MODELS.has(model)) {
		for (const origin of [
			"https://dashscope.aliyuncs.com",
			"https://dashscope-intl.aliyuncs.com",
		]) {
			if (officialEndpoint(endpoint, origin, ["/compatible-mode/v1"]))
				return IMPLICIT;
		}
		try {
			const url = new URL(endpoint);
			if (
				/^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(
					url.hostname,
				) &&
				officialEndpoint(endpoint, `https://${url.hostname}`, [
					"/compatible-mode/v1",
				])
			)
				return IMPLICIT;
		} catch {
			/* Unknown endpoint. */
		}
	}
	return UNKNOWN;
}

// Every built-in provider has an explicit decision; see docs/public-api/cache-policy.md for evidence.
const PROVIDER_POLICIES: Record<ProviderName, RouteResolver> = {
	anthropic: (model, route) =>
		!route.customEndpoint ||
		officialEndpoint(route.customEndpoint, "https://api.anthropic.com", [""])
			? anthropicPolicy(model, route.format)
			: UNKNOWN,
	"claude-console-api": (model, route) =>
		PROVIDER_POLICIES.anthropic(model, route),
	codex: (model, route) => {
		const endpoint = route.customEndpoint;
		if (
			!endpoint ||
			officialEndpoint(endpoint, "https://chatgpt.com", [
				"/backend-api/codex/responses",
			])
		) {
			const base = stripDatedModelSuffix(model) ?? model;
			return MODERN_OPENAI.test(base) || EARLIER_OPENAI.test(base)
				? IMPLICIT
				: UNKNOWN;
		}
		if (
			officialEndpoint(endpoint, "https://api.openai.com", ["/v1/responses"])
		) {
			return openaiPolicy(model);
		}
		return UNKNOWN;
	},
	"openai-compatible": (model, route) => {
		const endpoint = route.customEndpoint
			? parseCustomEndpointData(route.customEndpoint)?.endpoint
			: "https://api.openai.com";
		if (!endpoint) return UNKNOWN;
		return compatiblePolicy(model, endpoint, route.format);
	},
	"anthropic-compatible": (model, route) => {
		// A missing account endpoint may be overridden by runtime provider configuration.
		const endpoint = route.customEndpoint;
		if (!endpoint) return UNKNOWN;
		if (officialEndpoint(endpoint, "https://api.anthropic.com", ["", "/v1"]))
			return anthropicPolicy(model, route.format);
		if (officialEndpoint(endpoint, "https://openrouter.ai", ["/api/v1"]))
			return openrouterPolicy(model, route.format);
		if (officialEndpoint(endpoint, "https://api.minimax.io", ["/anthropic"]))
			return minimaxPolicy(model, route.format);
		if (officialEndpoint(endpoint, "https://api.z.ai", ["/api/anthropic"]))
			return glmPolicy(model);
		if (officialEndpoint(endpoint, "https://api.x.ai", ["", "/v1"]))
			return grokPolicy(model);
		if (
			officialEndpoint(endpoint, "https://api.deepseek.com", ["/anthropic"]) &&
			/^deepseek-(?:chat|reasoner|v\d|r1)/i.test(model)
		)
			return IMPLICIT;
		return UNKNOWN;
	},
	zai: (model) => glmPolicy(model),
	minimax: (model, route) => minimaxPolicy(model, route.format),
	grok: (model) => grokPolicy(model),
	// Same xAI models over a different front door; the endpoint is fixed in the
	// provider, so there is no custom endpoint to qualify the answer.
	"grok-subscription": (model) => grokPolicy(model),
	openrouter: (model, route) =>
		!route.customEndpoint ||
		officialEndpoint(route.customEndpoint, "https://openrouter.ai", ["/api/v1"])
			? openrouterPolicy(model, route.format)
			: UNKNOWN,
	kilo: () => UNKNOWN,
	"alibaba-coding-plan": () => UNKNOWN,
	qwen: () => UNKNOWN,
	ollama: () => UNKNOWN,
	"ollama-cloud": () => UNKNOWN,
	mimo: () => UNKNOWN,
	devin: () => UNKNOWN,
};

function glmPolicy(model: string): ModelCachePolicy {
	return /^glm-[45](?:\.\d+)?(?:-(?:air|airx|flash|flashx|plus|long))?$/i.test(
		model,
	)
		? IMPLICIT
		: UNKNOWN;
}

function grokPolicy(model: string): ModelCachePolicy {
	return /^grok-(?:[234](?:[.-]|$)|code-)/i.test(model) &&
		!/(?:image|video|imagine|voice)/i.test(model)
		? IMPLICIT
		: UNKNOWN;
}

function minimaxPolicy(model: string, format: ClientFormat): ModelCachePolicy {
	if (/^MiniMax-M(?:2\.[157]|3)(?:-highspeed)?$/i.test(model)) return IMPLICIT;
	if (/^MiniMax-M2(?:-Stable)?$/i.test(model) && format === "anthropic")
		return {
			mode: "explicit",
			defaultTtlMs: 300_000,
			refreshOnReuse: true,
			expiry: "unavailable",
			source: "gateway-policy",
			ttlAnchor: "unknown",
			ttlSemantics: "configured",
		};
	return UNKNOWN;
}

/** Unknown routes cannot inherit another route's cache retention policy. */
export function resolveModelCachePolicy(
	targetModel: string,
	routes: ModelCachePolicyRoute[],
	unresolvedRoutes = false,
): ModelCachePolicy | undefined {
	if (unresolvedRoutes || !routes.length) return undefined;
	return reduceModelCachePolicies(
		routes.map((route) =>
			isKnownProvider(route.provider)
				? PROVIDER_POLICIES[route.provider](targetModel, route)
				: UNKNOWN,
		),
	);
}

export function reduceModelCachePolicies(
	candidates: Array<ModelCachePolicy | undefined>,
): ModelCachePolicy | undefined {
	if (!candidates.length || candidates.some((policy) => !policy))
		return undefined;
	const policies = candidates as ModelCachePolicy[];
	const first = policies[0];
	const policy: ModelCachePolicy = {
		mode: policies.every((p) => p.mode === first.mode) ? first.mode : "unknown",
		expiry: "unavailable",
		source: policies.every((p) => p.source === "gateway-policy")
			? "gateway-policy"
			: "unknown",
	};
	if (policy.mode === "unknown" || policy.source === "unknown") return policy;
	for (const key of [
		"defaultTtlMs",
		"refreshOnReuse",
		"ttlAnchor",
		"ttlSemantics",
	] as const) {
		if (
			first[key] !== undefined &&
			policies.every((p) => p[key] === first[key])
		)
			Object.assign(policy, { [key]: first[key] });
	}
	const supported = policies.map((p) => p.supportedTtlMs);
	const firstSupported = supported[0];
	if (
		firstSupported !== undefined &&
		supported.every((ttls): ttls is number[] => ttls !== undefined)
	) {
		const shared = [...new Set(firstSupported)].filter((ttl) =>
			supported.every((ttls) => ttls.includes(ttl)),
		);
		if (shared.length) policy.supportedTtlMs = shared.sort((a, b) => a - b);
	}
	// A typical retention period cannot support a countdown to expiry.
	if (
		policies.every((p) => p.expiry === "estimated") &&
		(policy.mode === "explicit" || policy.mode === "implicit") &&
		(policy.ttlAnchor === "request_start" ||
			policy.ttlAnchor === "request_end") &&
		(policy.ttlSemantics === "configured" ||
			policy.ttlSemantics === "minimum") &&
		(policy.defaultTtlMs !== undefined || policy.supportedTtlMs?.length)
	)
		policy.expiry = "estimated";
	return policy;
}
