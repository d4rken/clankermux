import type { AliasReasoningEffort } from "@clankermux/types";
import { getModelFamily } from "./model-mappings";

const CLAUDE_EFFORTS: Record<string, readonly AliasReasoningEffort[]> = {
	opus: ["low", "medium", "high", "xhigh", "max"],
	sonnet: ["low", "medium", "high", "xhigh", "max"],
	haiku: ["low", "medium"],
	fable: ["low", "medium", "high", "xhigh", "max"],
};
const GPT_EFFORTS: Record<string, readonly AliasReasoningEffort[]> = {
	"gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.3-codex": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.4-mini": ["low", "medium"],
	"gpt-5.5": ["minimal", "low", "medium", "high", "xhigh"],
	// Codex's catalogue lists `max` for these, but the ChatGPT backend rejects it
	// on 5.x and backend-params clamps it to `xhigh`; publish what is delivered.
	"gpt-5.6-sol": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.6-terra": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-5.6-luna": ["minimal", "low", "medium", "high", "xhigh"],
	"gpt-6": ["low", "medium", "high", "xhigh", "max"],
	"gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
	"gpt-6-sol": ["low", "medium", "high", "xhigh", "max"],
	"gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
};

/**
 * What every alias offers, whatever its targets support: the request path maps
 * the chosen level onto each target it tries.
 */
export const ALIAS_ADVERTISED_EFFORTS: readonly AliasReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Providers an alias may hand the requested effort to. Codex and the OpenAI
 * adapters clamp it per model; Anthropic serves Claude Code's own effort as
 * sent; Z.AI accepted every level from `minimal` to `max` when probed; Devin
 * ignores the field and gets the effort through its model variant instead.
 * Any other provider has never been shown to accept it, and on an alias an
 * upstream 400 is final, so the effort is removed and the target uses its own
 * default.
 */
const ALIAS_EFFORT_PROVIDERS: ReadonlySet<string> = new Set([
	"codex",
	"openai-compatible",
	"qwen",
	"kilo",
	"anthropic",
	"claude-console-api",
	"zai",
	"devin",
]);

export function aliasEffortReachesProvider(provider: string): boolean {
	return ALIAS_EFFORT_PROVIDERS.has(provider);
}

export type TargetReasoningProfile =
	| { status: "known"; efforts: readonly AliasReasoningEffort[] }
	| { status: "unsupported" }
	| { status: "unknown" };

/** Model-only profiles are retained for format conversion callers without account context. */
export function getModelReasoningEfforts(
	model: string,
): readonly AliasReasoningEffort[] | null {
	const normalized = model.toLowerCase().trim().replace(/^.*\//, "");
	const family = getModelFamily(normalized);
	if (family) return CLAUDE_EFFORTS[family];
	if (/^gpt-5\.4-mini(?:$|-\d{4}-\d{2}-\d{2}$)/.test(normalized))
		return GPT_EFFORTS["gpt-5.4-mini"];
	if (/^gpt-6(?:$|[.-])/.test(normalized)) return GPT_EFFORTS["gpt-6"];
	if (/^gpt-5(?:$|[.-])/.test(normalized)) return GPT_EFFORTS["gpt-5"];
	return null;
}

/** Only named adapter/model combinations substantiate canonical effort mapping. */
export function resolveTargetReasoningProfile(
	model: string,
	provider: string,
): TargetReasoningProfile {
	const normalized = model.toLowerCase().trim().replace(/^.*\//, "");
	const gpt =
		Object.hasOwn(GPT_EFFORTS, normalized) ||
		["gpt-5.4-mini-2026-09-01", "gpt-6-astra-2026-09-03"].includes(normalized);
	const mapped =
		(provider === "codex" || provider === "openai-compatible") && gpt;
	if (!mapped) return { status: "unknown" };
	const efforts = getModelReasoningEfforts(model);
	return efforts ? { status: "known", efforts } : { status: "unknown" };
}

export function getAliasReasoningEfforts(
	model: string,
	provider: string,
): readonly AliasReasoningEffort[] | null {
	const profile = resolveTargetReasoningProfile(model, provider);
	return profile.status === "known" ? profile.efforts : null;
}
