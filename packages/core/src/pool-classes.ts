import { providerDisplayName } from "./provider-display";

/**
 * Which accounts can serve which requests, as a grouping of providers.
 *
 * The whole reason this file exists: a pool figure averaged over every account
 * implies the accounts are interchangeable, and they are not. A request for a
 * Claude model can be served by any Anthropic account and by NONE of the Codex
 * ones. Averaging five Anthropic accounts with one Codex account produces a
 * number that describes no decision anyone makes — and in production it read
 * comfortable for weeks while every single hard stop came from the one Codex
 * account having no sibling to fail over to.
 *
 * Grouping by provider is the honest approximation available from account data
 * alone. It is not exact — an Anthropic-compatible endpoint may serve a subset
 * of models — but it captures the boundary that actually blocks failover, which
 * a single pooled average erases entirely.
 */
export interface ServableClass {
	classId: string;
	/** What the class is called on screen — the models, not the vendor. */
	label: string;
	providers: ReadonlySet<string>;
}

/**
 * Known classes, in display order. Inline named constants — no env gate.
 *
 * Labels name the MODELS a class serves rather than the account vendor, because
 * the question the card answers is "can my next request be served", and the
 * reader thinks in models.
 */
const KNOWN_CLASSES: readonly ServableClass[] = [
	{
		classId: "anthropic",
		label: "Claude",
		providers: new Set(["anthropic", "anthropic-compatible", "bedrock"]),
	},
	{ classId: "codex", label: "GPT", providers: new Set(["codex", "openai"]) },
	{ classId: "qwen", label: "Qwen", providers: new Set(["qwen"]) },
];

const CLASS_BY_PROVIDER = new Map<string, ServableClass>();
for (const servable of KNOWN_CLASSES) {
	for (const provider of servable.providers) {
		CLASS_BY_PROVIDER.set(provider, servable);
	}
}

/**
 * The servable class an account belongs to.
 *
 * An unrecognised provider becomes its own single-provider class rather than
 * being folded into a catch-all. Merging unknowns would recreate the exact
 * error this module exists to remove — claiming failover between accounts that
 * cannot cover for each other — and a provider added to the proxy without being
 * listed here then shows up as its own card, which is visible and harmless,
 * rather than silently inflating another class's headroom.
 */
export function servableClassFor(provider: string): ServableClass {
	const known = CLASS_BY_PROVIDER.get(provider);
	if (known) return known;
	return {
		classId: provider,
		label: providerDisplayName(provider),
		providers: new Set([provider]),
	};
}

/** Display order: known classes first in their declared order, then the rest. */
export function compareServableClasses(a: string, b: string): number {
	const order = KNOWN_CLASSES.findIndex((c) => c.classId === a);
	const otherOrder = KNOWN_CLASSES.findIndex((c) => c.classId === b);
	if (order !== -1 && otherOrder !== -1) return order - otherOrder;
	if (order !== -1) return -1;
	if (otherOrder !== -1) return 1;
	return a.localeCompare(b);
}
