/**
 * The fiction behind the README screenshots.
 *
 * Every name here is invented. The screenshots in `docs/media/` are captures of
 * a REAL ClankerMux instance, so whatever this file says is what the world sees
 * — it must never acquire a real account name, address, organization, project
 * or spend figure. See `scripts/build-readme-screenshots.ts` for how it is used.
 */

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

/** Invented client identities for the API-key column. */
export const MOCK_API_KEYS = [
	{ id: "key-workstation", name: "workstation", last8: "a41c9f2e" },
	{ id: "key-ci", name: "ci-runner", last8: "77b0d413" },
	{ id: "key-laptop", name: "laptop", last8: "e0592aa8" },
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
