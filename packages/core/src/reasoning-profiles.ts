import {
	ALIAS_REASONING_EFFORTS,
	type AliasReasoningEffort,
	isOfficialAnthropicProvider,
	oneMillionContextBase,
} from "@clankermux/types";
import { getModelFamily } from "./model-mappings";

/** The levels every Claude model that takes an effort accepts. */
const CLAUDE_EFFORTS: readonly AliasReasoningEffort[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
/**
 * Whether a Claude model takes an effort at all: Opus 4.5, and every model
 * from 4.6 on.
 *
 *   claude-opus-4-5, claude-sonnet-4-6, claude-opus-5-5[1m]  -> true
 *   claude-haiku-4-5, claude-opus-4-1, claude-3-5-haiku-*   -> false
 */
export function claudeModelTakesEffort(model: string): boolean {
	const id = model.toLowerCase().trim().replace(/^.*\//, "");
	const match =
		/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8}|-latest)?$/.exec(
			oneMillionContextBase(id) ?? id,
		);
	if (!match) return false;
	const major = Number(match[2]);
	const minor = Number(match[3] ?? 0);
	if (major !== 4) return major > 4;
	return minor >= 6 || (match[1] === "opus" && minor === 5);
}
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
	"gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
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
 * Providers an alias may hand the requested effort to. Codex clamps it per
 * model; Anthropic and the Claude API get it clamped to the Claude family's
 * range; Z.AI accepted every level from `minimal` to `max` when probed; Devin
 * ignores the field and gets the effort through its model variant instead.
 * Any other provider has never been shown to accept it (the OpenAI-compatible
 * converter behind openai-compatible, qwen and kilo reads only
 * `reasoning.effort`, so an alias request's `output_config.effort` would be
 * dropped silently), and on an alias an upstream 400 is final, so the effort
 * is removed and the target uses its own default.
 */
const ALIAS_EFFORT_PROVIDERS: ReadonlySet<string> = new Set([
	"codex",
	"anthropic",
	"claude-console-api",
	"zai",
	"devin",
]);

export function aliasEffortReachesProvider(provider: string): boolean {
	return ALIAS_EFFORT_PROVIDERS.has(provider);
}

/** Providers that serve Claude, where an alias effort must fit the model's family. */
const CLAUDE_EFFORT_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"claude-console-api",
]);

export function aliasEffortClampsToClaudeFamily(provider: string): boolean {
	return CLAUDE_EFFORT_PROVIDERS.has(provider);
}

/**
 * `effort` lowered to the nearest level `model` accepts, else the lowest it
 * accepts. An unknown model or a value outside the vocabulary is returned
 * unchanged.
 */
export function clampEffortToModel(model: string, effort: string): string {
	const efforts = getModelReasoningEfforts(model);
	const rank = (level: string) =>
		ALIAS_REASONING_EFFORTS.indexOf(level as AliasReasoningEffort);
	if (!efforts?.length || rank(effort) < 0) return effort;
	return efforts.findLast((level) => rank(level) <= rank(effort)) ?? efforts[0];
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
	if (getModelFamily(normalized)) return CLAUDE_EFFORTS;
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
	const claude =
		isOfficialAnthropicProvider(provider) && claudeModelTakesEffort(normalized);
	const mapped =
		((provider === "codex" || provider === "openai-compatible") && gpt) ||
		claude;
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
