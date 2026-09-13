/**
 * The fiction behind the README screenshots.
 *
 * Every name here is invented. The screenshots in `docs/media/` are captures of
 * a REAL ClankerMux instance, so whatever this file says is what the world sees
 * — it must never acquire a real account name, address, organization, project
 * or spend figure. See `scripts/build-readme-screenshots.ts` for how it is used.
 */

import type {
	ClientModel,
	ClientProfile,
	RoutingRule,
} from "@clankermux/types";

/** Deterministic PRNG so a re-capture produces the same figures, not new ones. */
export function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		// mulberry32
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface MockAccount {
	id: string;
	name: string;
	provider: string;
	priority: number;
	paused: boolean;
	planTier: string | null;
	email: string | null;
	organization: string | null;
	/** Fraction of total traffic this account carries. */
	share: number;
	/** Models this account is allowed to serve, for the request generator. */
	models: string[];
	/** Where its 5h window sits at capture time, 0..1. Null = no window concept. */
	fiveHourPct: number | null;
	/** Where its weekly window sits at capture time, 0..1. */
	sevenDayPct: number | null;
	/** Monthly subscription price in whole USD, or null for pay-as-you-go. */
	monthlyUsd: number | null;
}

export const MOCK_ACCOUNTS: MockAccount[] = [
	{
		id: "acct-aurora",
		name: "aurora-max",
		provider: "anthropic",
		priority: 0,
		paused: false,
		planTier: "max_20x",
		email: "aurora@northwind.example",
		organization: "Northwind Labs",
		share: 0.38,
		models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4.5"],
		fiveHourPct: 0.62,
		sevenDayPct: 0.71,
		monthlyUsd: 200,
	},
	{
		id: "acct-borealis",
		name: "borealis-max",
		provider: "anthropic",
		priority: 1,
		paused: false,
		planTier: "max_5x",
		email: "borealis@northwind.example",
		organization: "Northwind Labs",
		share: 0.24,
		models: ["claude-sonnet-5", "claude-fable-5", "claude-haiku-4.5"],
		fiveHourPct: 0.34,
		sevenDayPct: 0.48,
		monthlyUsd: 100,
	},
	{
		id: "acct-cinder",
		name: "cinder-codex",
		provider: "codex",
		priority: 2,
		paused: false,
		planTier: "pro",
		email: "cinder@northwind.example",
		organization: null,
		share: 0.21,
		models: ["gpt-5.6-sol", "gpt-5.4-mini"],
		fiveHourPct: 0.45,
		sevenDayPct: 0.29,
		monthlyUsd: 200,
	},
	{
		id: "acct-dune",
		name: "dune-openrouter",
		provider: "openrouter",
		priority: 3,
		paused: false,
		planTier: null,
		email: null,
		organization: null,
		share: 0.12,
		models: ["glm-4.6"],
		fiveHourPct: null,
		sevenDayPct: null,
		monthlyUsd: null,
	},
	{
		id: "acct-ember",
		name: "ember-local",
		provider: "ollama",
		priority: 4,
		paused: true,
		planTier: null,
		email: null,
		organization: null,
		share: 0.05,
		models: ["glm-4.6"],
		fiveHourPct: null,
		sevenDayPct: null,
		monthlyUsd: null,
	},
];

/** Invented project names, as the attribution layer would report them. */
export const MOCK_PROJECTS = [
	"northwind-web",
	"atlas-api",
	"pathfinder-cli",
	"docs-site",
	"scratchpad",
] as const;

/**
 * Invented client identities, for the API-key column and the Clients page.
 *
 * The two pin fields are the key's upstream destinations, and at most one of
 * them may be set. A key carrying both is logged at boot as having "invalid
 * destinations and will reject inference", and the Clients page shows the
 * account pin while the providers are silently ignored.
 */
export const MOCK_API_KEYS = [
	{
		id: "key-workstation",
		name: "workstation",
		last8: "a41c9f2e",
		pinnedAccountId: null,
		pinnedProviders: ["anthropic"],
	},
	{
		id: "key-ci",
		name: "ci-runner",
		last8: "77b0d413",
		pinnedAccountId: "acct-dune",
		pinnedProviders: null,
	},
	{
		id: "key-laptop",
		name: "laptop",
		last8: "e0592aa8",
		pinnedAccountId: null,
		pinnedProviders: ["codex"],
	},
] as const;

export const MOCK_COMBOS = [
	{
		id: "combo-frontline",
		name: "frontline",
		description: "Opus first, Sonnet behind it, local model as the floor.",
	},
	{
		id: "combo-bulk",
		name: "bulk",
		description: "Cheap models for batch and background work.",
	},
] as const;

/** A catalogue entry that advertises an upstream model under its own ID. */
const published = (id: string, displayName: string): ClientModel => ({
	id,
	displayName,
	targetModel: id,
	accountIds: null,
});

/**
 * A Codex entry, with the saved upstream metadata the format requires.
 *
 * A Codex catalogue entry without it raises a per-client notice on the Clients
 * page, and `renderClientCatalogue` drops the entry from `GET /v1/models`
 * unless the saved `slug` equals the target model.
 */
const codexPublished = (id: string, displayName: string): ClientModel => ({
	...published(id, displayName),
	codexMetadata: { slug: id, display_name: displayName },
});

/**
 * The three clients behind {@link MOCK_API_KEYS}, as the Clients page reads
 * them.
 *
 * All three format catalogues are present on every profile because the page
 * counts each one unconditionally and the stored JSON is parsed without
 * defaults. `notices: []` keeps the rows clean: the page derives its own
 * notices on top of these, and a figure carrying a warning describes the
 * capture rig rather than the product.
 */
export const MOCK_CLIENT_PROFILES: ClientProfile[] = [
	{
		apiKeyId: "key-workstation",
		application: "claude-code",
		revision: 1,
		catalogues: {
			anthropic: {
				models: [
					published("claude-opus-5", "Claude Opus 5"),
					published("claude-sonnet-5", "Claude Sonnet 5"),
					published("claude-haiku-4.5", "Claude Haiku 4.5"),
				],
				defaultModel: "claude-sonnet-5",
			},
			openai: { models: [], defaultModel: null },
			codex: { models: [], defaultModel: null },
		},
		notices: [],
	},
	{
		apiKeyId: "key-ci",
		application: "generic",
		revision: 1,
		catalogues: {
			anthropic: { models: [], defaultModel: null },
			openai: {
				models: [
					// An alias: the client asks for `ci-default` and the rule of the
					// same name in MOCK_ROUTING_RULES sends `glm-4.6` upstream.
					{
						id: "ci-default",
						displayName: "CI default",
						targetModel: "glm-4.6",
						accountIds: ["acct-dune"],
					},
					published("glm-4.6", "GLM 4.6"),
				],
				defaultModel: "ci-default",
			},
			codex: { models: [], defaultModel: null },
		},
		notices: [],
	},
	{
		apiKeyId: "key-laptop",
		application: "codex",
		revision: 1,
		catalogues: {
			anthropic: { models: [], defaultModel: null },
			openai: {
				models: [
					published("gpt-5.6-sol", "GPT-5.6 Sol"),
					published("gpt-5.4-mini", "GPT-5.4 Mini"),
				],
				defaultModel: "gpt-5.6-sol",
			},
			codex: {
				models: [
					codexPublished("gpt-5.6-sol", "GPT-5.6 Sol"),
					codexPublished("gpt-5.4-mini", "GPT-5.4 Mini"),
				],
				defaultModel: "gpt-5.6-sol",
			},
		},
		notices: [],
	},
];

/**
 * A routing rule as this file states it. `position` is left out on purpose: the
 * column is UNIQUE across every rule, so the seeder numbers the array instead
 * of the fixture carrying hand-maintained positions that can collide.
 */
export interface MockRoutingRule extends Omit<RoutingRule, "position"> {
	/** The client that owns this alias rule, or null for an operator rule. */
	ownedByClient: string | null;
}

/**
 * The routing table, in evaluation order: the first enabled rule matching the
 * API key and the requested model wins.
 *
 * Alias rules come first. An alias shadowed by an earlier rule loses its target
 * rewrite and its client grows a notice saying so.
 */
export const MOCK_ROUTING_RULES: MockRoutingRule[] = [
	{
		id: "rule-ci-default",
		name: "ci-runner: ci-default",
		enabled: true,
		ownedByClient: "key-ci",
		match_api_key_id: "key-ci",
		match_model_kind: "exact",
		match_model_value: "ci-default",
		pool_kind: "accounts",
		pool_provider: null,
		pool_account_ids: ["acct-dune"],
		target_kind: "literal",
		target_model: "glm-4.6",
	},
	{
		id: "rule-opus-aurora",
		name: "Opus stays on aurora-max",
		enabled: true,
		ownedByClient: null,
		match_api_key_id: null,
		// Families are matched as `provider:family`; a bare "opus" is rejected.
		match_model_kind: "family",
		match_model_value: "anthropic:opus",
		pool_kind: "accounts",
		pool_provider: null,
		pool_account_ids: ["acct-aurora"],
		target_kind: "requested",
		target_model: null,
	},
	{
		id: "rule-sonnet-pool",
		name: "Sonnet across the Anthropic pool",
		enabled: true,
		ownedByClient: null,
		match_api_key_id: null,
		match_model_kind: "family",
		match_model_value: "anthropic:sonnet",
		pool_kind: "accounts",
		pool_provider: null,
		pool_account_ids: ["acct-aurora", "acct-borealis"],
		target_kind: "requested",
		target_model: null,
	},
	{
		id: "rule-codex-provider",
		name: "Sol on a Codex account",
		enabled: true,
		ownedByClient: null,
		match_api_key_id: null,
		match_model_kind: "exact",
		match_model_value: "gpt-5.6-sol",
		pool_kind: "provider",
		pool_provider: "codex",
		pool_account_ids: null,
		target_kind: "requested",
		target_model: null,
	},
	{
		id: "rule-haiku-local",
		name: "Haiku to the local model",
		enabled: false,
		ownedByClient: null,
		match_api_key_id: null,
		match_model_kind: "family",
		match_model_value: "anthropic:haiku",
		pool_kind: "accounts",
		pool_provider: null,
		pool_account_ids: ["acct-ember"],
		target_kind: "literal",
		target_model: "glm-4.6",
	},
];
