import { stripDatedModelSuffix } from "@clankermux/core";
import {
	MODEL_SUBSTITUTION_EXCEPTION_WILDCARD,
	type ModelSubstitutionException,
} from "@clankermux/types";

/**
 * Decides whether the model a provider says it served is a DIFFERENT model from
 * the one this proxy sent.
 *
 * Every false positive here turns a working response into a client-visible
 * error, so the rule is deliberately conservative: it answers true only when the
 * two ids survive every normalisation below and still disagree.
 *
 * Direction is not considered. Ranking a substitute as better or worse would
 * need a price for it, and the model that has just appeared out of nowhere is
 * exactly the one with no catalogue entry — `getModelCacheRates` answers for an
 * unknown id with Sonnet-4's rates rather than admitting it does not know.
 */

/**
 * Slugs a backend resolves to a real model by design. Sending one and being
 * answered by something else is the contract, not a substitution.
 *
 * `codex-auto-review` is the Codex CLI's review model: 671 attempts observed in
 * this deployment, every one of them "mismatched". `coder-model` is the Qwen
 * equivalent. Neither appears anywhere else in this codebase, because both are
 * client-supplied strings that pass through untouched.
 */
export const BACKEND_RESOLVED_SLUGS: ReadonlySet<string> = new Set([
	"codex-auto-review",
	"coder-model",
]);

/**
 * Matches the TTL the definitive-rejection path already uses. At the rate
 * substitution has been observed (~87% of one account's sends) this is closer to
 * removal than to backoff, which is the intent: it turns one wasted upstream
 * attempt per request into one per window.
 */
export const SERVED_MODEL_SUPPRESSION_MS = 300_000;

/**
 * Anthropic writes snapshot dates without separators
 * (`claude-haiku-4-5-20251001`), where the Codex/OpenAI families use
 * `-YYYY-MM-DD`. Both forms alias the same model as the undated slug, and both
 * are live in this deployment.
 *
 * Deliberately NOT folded into core's `stripDatedModelSuffix`: that one is a
 * second-chance key for the pricing and context-window tables, where a snapshot
 * may legitimately be priced differently from its base. Widening it would change
 * six lookups to fix one comparison.
 */
const COMPACT_DATED_SUFFIX = /^(.+)-\d{8}$/;

/** `anthropic/claude-opus-5` and `claude-opus-5` are one model to OpenRouter. */
function stripVendorPrefix(model: string): string {
	return model.replace(/^.*\//, "");
}

/**
 * OpenRouter appends a routing variant to the same underlying model:
 * `qwen/qwen3.6-plus:free`, `:nitro`, `:beta`, `:extended`. The variant selects
 * how the request is served, not what serves it, so it must not read as a swap.
 *
 * An ALLOWLIST, not "strip whatever follows the last colon". Ollama uses the
 * same separator for the model's identity — `llama3:8b` and `llama3:70b` are
 * different models with different weights — so a blanket rule would quietly
 * equate them and disable detection for every colon-tagged provider.
 */
const ROUTE_VARIANTS: ReadonlySet<string> = new Set([
	"free",
	"nitro",
	"beta",
	"extended",
	"floor",
	"online",
]);

function stripRouteVariant(model: string): string {
	const colon = model.lastIndexOf(":");
	if (colon <= 0) return model;
	return ROUTE_VARIANTS.has(model.slice(colon + 1))
		? model.slice(0, colon)
		: model;
}

/** Every spelling of one model id, cheapest test first. */
function aliases(model: string): string[] {
	const base = stripRouteVariant(stripVendorPrefix(model.toLowerCase().trim()));
	const undated =
		stripDatedModelSuffix(base) ?? COMPACT_DATED_SUFFIX.exec(base)?.[1] ?? null;
	return undated === null ? [base] : [base, undated];
}

/**
 * @param sent the model this proxy put on the wire
 * @param served the model the provider named in its response
 */
export function isModelSubstitution(sent: string, served: string): boolean {
	if (!sent || !served) return false;
	if (BACKEND_RESOLVED_SLUGS.has(sent.toLowerCase().trim())) return false;
	const sentAliases = aliases(sent);
	const servedAliases = aliases(served);
	return !sentAliases.some((candidate) => servedAliases.includes(candidate));
}

/**
 * Whether an operator has declared this particular swap acceptable.
 *
 * Runs through the SAME normalisation as `isModelSubstitution`, so an exception
 * written against the undated alias also covers the dated snapshot, and one
 * written for `anthropic/claude-opus-5` also covers the bare id. Writing the
 * rule one way and having it silently miss the other spelling of the same model
 * is exactly the failure this comparison exists to avoid.
 *
 * `*` on either side matches any model. Both sides wildcarded is rejected at
 * parse time.
 */
export function isSubstitutionExcepted(
	sent: string,
	served: string,
	exceptions: readonly ModelSubstitutionException[],
): boolean {
	if (exceptions.length === 0) return false;
	const sentAliases = aliases(sent);
	const servedAliases = aliases(served);
	return exceptions.some(
		(exception) =>
			matchesSide(exception.sent, sentAliases) &&
			matchesSide(exception.served, servedAliases),
	);
}

function matchesSide(pattern: string, candidates: readonly string[]): boolean {
	if (pattern === MODEL_SUBSTITUTION_EXCEPTION_WILDCARD) return true;
	const patternAliases = aliases(pattern);
	return patternAliases.some((alias) => candidates.includes(alias));
}
