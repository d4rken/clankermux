import { describe, expect, it, mock } from "bun:test";
import type {
	Account,
	AccountModelPermissions,
	ClientApplication,
	RequestMeta,
	RoutingRule,
} from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import { getAliasRoutes, getResolvedRoute } from "../resolved-route";
import { initializeRequestRoute } from "../routing-service";

const account = (id: string, provider: string): Account =>
	({ id, name: id, provider, disabled: 0 }) as unknown as Account;
const codex = account("codex-1", "codex");
const codex2 = account("codex-2", "codex");
const claude = account("claude-1", "anthropic");
const lists: Record<string, string[]> = {
	"codex-1": ["gpt-6-astra", "gpt-6-sol"],
	"codex-2": ["gpt-6-astra", "gpt-6-sol"],
	"claude-1": ["claude-opus-5-5", "claude-fable-5-1"],
};
const rule = (overrides: Partial<RoutingRule>): RoutingRule => ({
	id: "rule",
	name: "Rule",
	enabled: true,
	position: 0,
	match_api_key_id: null,
	match_model_kind: "exact",
	match_model_value: null,
	pool_kind: "inherit",
	pool_provider: null,
	pool_account_ids: null,
	target_kind: "requested",
	target_model: null,
	...overrides,
});

function setup({
	application = "claude-code",
	rules = [],
	unknown = [],
	manual = {},
	accounts = [codex, codex2, claude],
}: {
	application?: ClientApplication | null;
	rules?: RoutingRule[];
	unknown?: string[];
	manual?: Record<string, string[]>;
	accounts?: Account[];
} = {}) {
	const refreshMisses = mock(async () => {});
	const permissions = (a: Account): AccountModelPermissions => ({
		account_id: a.id,
		scope: modelPermissionScope(a),
		generation: 1,
		completeness: unknown.includes(a.id) ? "unknown" : "known-complete",
		discovered_ids: unknown.includes(a.id) ? [] : (lists[a.id] ?? []),
		manual_ids: manual[a.id] ?? [],
		last_success_at: 1,
		last_attempt_at: 1,
		last_error: null,
	});
	const ctx = {
		modelPermissions: {
			permissions: async (a: Account) => permissions(a),
			refreshMisses,
		},
		dbOps: {
			getApiKeyPin: async () => ({
				pinnedAccountId: null,
				pinnedProviders: null,
				excludedProviders: null,
				malformed: false,
				application,
			}),
			getAllAccounts: async () => accounts,
			routing: {
				listRules: async () => rules,
				isModelSuppressed: async () => false,
			},
			modelAliases: {
				get: async (id: string) =>
					id === "alias:frontier"
						? {
								id,
								displayName: "Frontier",
								revision: 1,
								targets: [{ model: "gpt-6-astra", accountIds: null }],
							}
						: null,
			},
		},
	} as unknown as ProxyContext;
	return { ctx, refreshMisses };
}
async function route(model: string, ctx: ProxyContext) {
	const meta = { requestedModel: model, headers: new Headers() } as RequestMeta;
	await initializeRequestRoute(meta, ctx, "key-1", null);
	return meta;
}
const upstream = (meta: RequestMeta, a: Account) =>
	getResolvedRoute(meta).target(a)?.upstreamModel ?? null;

describe("Claude Code model names", () => {
	it("routes a prefixed name as the real model and keeps the requested name", async () => {
		const { ctx, refreshMisses } = setup();
		const meta = await route("claude-gpt-6-astra", ctx);
		expect(upstream(meta, codex)).toBe("gpt-6-astra");
		expect(upstream(meta, codex2)).toBe("gpt-6-astra");
		expect(upstream(meta, claude)).toBeNull();
		expect(getResolvedRoute(meta).requestedModel).toBe("claude-gpt-6-astra");
		expect(JSON.parse(getResolvedRoute(meta).snapshot)).toEqual(
			expect.objectContaining({
				requestedModel: "claude-gpt-6-astra",
				routingModel: "gpt-6-astra",
			}),
		);
		// Once translated it is an ordinary gpt-6-astra request, which asks the
		// Claude account (whose list lacks it) to refresh as it always has.
		expect(refreshMisses).toHaveBeenCalledTimes(1);
	});

	it("decides from stored model lists without refreshing any", async () => {
		const { ctx, refreshMisses } = setup({ accounts: [codex, codex2] });
		const meta = await route("claude-gpt-6-astra", ctx);
		expect(upstream(meta, codex)).toBe("gpt-6-astra");
		expect(refreshMisses).not.toHaveBeenCalled();
	});

	it("routes a prefixed model group as that group", async () => {
		const { ctx } = setup();
		const meta = await route("claude-alias:frontier", ctx);
		expect(getAliasRoutes(meta)?.length).toBe(1);
		expect(upstream(meta, codex)).toBe("gpt-6-astra");
		expect(JSON.parse(getResolvedRoute(meta).snapshot).routingModel).toBe(
			"alias:frontier",
		);
	});

	it("leaves a real Claude model alone", async () => {
		const { ctx } = setup();
		const meta = await route("claude-opus-5-5", ctx);
		expect(upstream(meta, claude)).toBe("claude-opus-5-5");
		expect(upstream(meta, codex)).toBeNull();
	});

	it("translates only for Claude Code clients", async () => {
		for (const application of ["generic", "pi", null] as const) {
			const { ctx } = setup({ application });
			await expect(route("claude-gpt-6-astra", ctx)).rejects.toThrow();
		}
	});

	it("lets a rule written for the prefixed name decide instead", async () => {
		const { ctx } = setup({
			rules: [
				rule({
					match_model_value: "claude-gpt-6-astra",
					target_kind: "literal",
					target_model: "gpt-6-sol",
				}),
			],
		});
		const meta = await route("claude-gpt-6-astra", ctx);
		expect(upstream(meta, codex)).toBe("gpt-6-sol");
	});

	it("applies every rule for the real name to the translated request", async () => {
		const pooled = setup({
			rules: [
				rule({
					match_model_value: "gpt-6-astra",
					pool_kind: "accounts",
					pool_account_ids: ["codex-2"],
				}),
			],
		});
		const onlyOne = await route("claude-gpt-6-astra", pooled.ctx);
		expect(upstream(onlyOne, codex)).toBeNull();
		expect(upstream(onlyOne, codex2)).toBe("gpt-6-astra");

		const remapped = setup({
			rules: [
				rule({
					match_model_value: "gpt-6-astra",
					target_kind: "literal",
					target_model: "gpt-6-sol",
				}),
			],
		});
		const sol = await route("claude-gpt-6-astra", remapped.ctx);
		expect(upstream(sol, codex)).toBe("gpt-6-sol");

		const byProvider = setup({
			rules: [
				rule({
					id: "broad",
					position: 5,
					match_model_kind: "any",
					pool_kind: "provider",
					pool_provider: "anthropic",
				}),
			],
		});
		// The broad rule pools Anthropic accounts, and none offers gpt-6-astra.
		await expect(route("claude-gpt-6-astra", byProvider.ctx)).rejects.toThrow();
	});

	it("lets an account whose list is unknown count only through its manual models", async () => {
		const quiet = setup({ unknown: ["codex-2"] });
		const translated = await route("claude-gpt-6-astra", quiet.ctx);
		expect(upstream(translated, codex)).toBe("gpt-6-astra");

		// Its operator says it serves the name as sent, so that name stays.
		const listed = setup({
			unknown: ["codex-2"],
			manual: { "codex-2": ["claude-gpt-6-astra"] },
		});
		const kept = await route("claude-gpt-6-astra", listed.ctx);
		expect(upstream(kept, codex2)).toBe("claude-gpt-6-astra");
		expect(upstream(kept, codex)).toBeNull();
	});

	it("never translates a real Claude model name, so its family rules keep applying", async () => {
		lists["codex-1"]?.push("opus-5-5");
		try {
			const { ctx } = setup({
				rules: [
					rule({
						match_model_kind: "family",
						match_model_value: "anthropic:opus",
						pool_kind: "provider",
						pool_provider: "anthropic",
					}),
				],
			});
			const meta = await route("claude-opus-5-5", ctx);
			expect(upstream(meta, claude)).toBe("claude-opus-5-5");
			expect(upstream(meta, codex)).toBeNull();
		} finally {
			lists["codex-1"]?.pop();
		}
	});

	it("keeps the prefixed name when an account really serves it", async () => {
		lists["claude-1"]?.push("claude-gpt-6-astra");
		try {
			const { ctx } = setup();
			const meta = await route("claude-gpt-6-astra", ctx);
			expect(upstream(meta, claude)).toBe("claude-gpt-6-astra");
		} finally {
			lists["claude-1"]?.pop();
		}
	});
});
