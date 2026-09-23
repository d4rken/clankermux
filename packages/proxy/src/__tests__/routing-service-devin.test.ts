import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { devinClient } from "@clankermux/providers";
import type { Account, ModelAlias, RequestMeta } from "@clankermux/types";
import { setChatContext } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import { getAliasRoutes, getResolvedRoute } from "../resolved-route";
import { initializeRequestRoute } from "../routing-service";

let lookup: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	lookup?.mockRestore();
	lookup = undefined;
});
function setup(model = "swe-2-high", permitted = ["swe-2-high"]) {
	const account = {
		id: "devin-route",
		provider: "devin",
		name: "Devin",
		api_key: "session",
		custom_endpoint: null,
	} as Account;
	const suppression = mock(async (..._args: unknown[]) => false);
	const refresh = mock(async () => {});
	const ctx = {
		dbOps: {
			getAllAccounts: async () => [account],
			routing: { listRules: async () => [], isModelSuppressed: suppression },
		},
		modelPermissions: {
			permissions: async () => ({
				scope: modelPermissionScope(account),
				completeness: "known-complete",
				discovered_ids: permitted,
				manual_ids: [],
			}),
			refreshMisses: refresh,
		},
	} as unknown as ProxyContext;
	const meta = {
		id: crypto.randomUUID(),
		requestedModel: model,
		path: "/v1/messages",
		method: "POST",
		timestamp: Date.now(),
	} as RequestMeta;
	return { account, ctx, meta, suppression, refresh };
}
it("freezes the requested Devin model without any provider metadata fetch", async () => {
	// Routing no longer asks Devin what a family alias means, so no account
	// metadata call may happen while a route is being resolved.
	lookup = spyOn(devinClient, "getAccount").mockRejectedValue(
		new Error("must not fetch"),
	);
	const { account, ctx, meta, suppression, refresh } = setup();
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).target(account)?.upstreamModel).toBe(
		"swe-2-high",
	);
	expect(lookup).not.toHaveBeenCalled();
	expect(refresh).not.toHaveBeenCalled();
	expect(suppression.mock.calls[0]?.[2]).toBe("swe-2-high");
});
it("rejects a Claude model on a Devin account that does not permit it", async () => {
	// The old provider-default map turned this into "swe-2" and then into a
	// concrete variant. Without a rule there is now no destination at all.
	const { ctx, meta, refresh } = setup("claude-sonnet-4-5", ["swe-2-high"]);
	await expect(initializeRequestRoute(meta, ctx, null, null)).rejects.toThrow(
		'does not permit model "claude-sonnet-4-5"',
	);
	expect(refresh).toHaveBeenCalledTimes(1);
});
it("rejects the bare SWE-2 alias when only a concrete variant is permitted", async () => {
	const { ctx, meta } = setup("swe-2", ["swe-2-high"]);
	await expect(initializeRequestRoute(meta, ctx, null, null)).rejects.toThrow(
		'does not permit model "swe-2"',
	);
});

// Chat cannot route to Devin, so an unusable Devin account must not replace the
// actual Chat rejection with advice about an unsupported destination.
it.each([
	true,
	false,
])("preserves Chat rejection diagnostics with a Devin account present (Codex present: %s)", async (includeCodex) => {
	const { account, ctx, meta } = setup("swe-2", ["swe-2"]);
	const codex = { ...account, id: "codex-route", provider: "codex" } as Account;
	ctx.dbOps.getAllAccounts = async () =>
		includeCodex ? [account, codex] : [account];
	const permissions = ctx.modelPermissions;
	if (!permissions) throw new Error("Missing test permissions");
	permissions.permissions = async (candidate: Account) => ({
		account_id: candidate.id,
		scope: modelPermissionScope(candidate),
		generation: 1,
		completeness: "known-complete",
		discovered_ids: ["swe-2", "swe-2-high"],
		manual_ids: [],
		last_success_at: Date.now(),
		last_attempt_at: Date.now(),
		last_error: null,
	});
	setChatContext(meta, {
		requirements: { fields: ["max_tokens"] },
		defaultMaxTokens: 8192,
	});
	await expect(
		initializeRequestRoute(meta, ctx, null, null),
	).rejects.toMatchObject(
		includeCodex
			? {
					statusCode: 400,
					code: "unsupported_parameter",
					param: "max_tokens",
					message:
						'No permitted destination for model "swe-2" can honor Chat Completions field "max_tokens"',
				}
			: {
					statusCode: 403,
					code: "routing_policy_rejected",
					message:
						'No permitted destination for model "swe-2" supports Chat Completions; supported providers are codex and openrouter',
				},
	);
});

describe("alias stages map the requested effort onto a Devin variant", () => {
	const variant = (effort: string, dimensions = "") => ({
		family: "SWE-2",
		effort,
		dimensions,
	});
	const variants = {
		"swe-2-medium": variant("medium"),
		"swe-2-high": variant("high"),
		"swe-2-max": variant("max"),
		"swe-2-high-fast": variant("high", "Fast Mode=@1"),
		"swe-2-max-fast": variant("max", "Fast Mode=@1"),
	};
	function aliasSetup(
		target: string,
		reasoningEffort?: string,
		discoveredBeforeRefresh = true,
	) {
		const devin = {
			id: "devin-route",
			provider: "devin",
			name: "Devin",
			api_key: "session",
			custom_endpoint: null,
		} as Account;
		const codex = { ...devin, id: "codex-route", provider: "codex" } as Account;
		const suppression = mock(async (..._args: unknown[]) => false);
		let discovered = discoveredBeforeRefresh;
		const refreshMisses = mock(async () => {
			discovered = true;
		});
		const alias: ModelAlias = {
			id: "alias:balanced",
			displayName: "Balanced",
			revision: 1,
			targets: [
				{ model: target, accountIds: [devin.id] },
				{ model: "gpt-5.6-sol", accountIds: [codex.id] },
			],
		};
		const ctx = {
			dbOps: {
				getAllAccounts: async () => [devin, codex],
				routing: { listRules: async () => [], isModelSuppressed: suppression },
				modelAliases: { get: async () => alias },
			},
			modelPermissions: {
				permissions: async (a: Account) => ({
					account_id: a.id,
					scope: modelPermissionScope(a),
					generation: 1,
					completeness: "known-complete",
					discovered_ids:
						a.provider !== "devin"
							? ["gpt-5.6-sol"]
							: discovered
								? Object.keys(variants)
								: [],
					manual_ids: [],
					last_success_at: Date.now(),
					last_attempt_at: Date.now(),
					last_error: null,
					model_variants: a.provider === "devin" && discovered ? variants : {},
				}),
				refreshMisses,
			},
		} as unknown as ProxyContext;
		const meta = {
			id: crypto.randomUUID(),
			requestedModel: alias.id,
			path: "/v1/messages",
			method: "POST",
			timestamp: Date.now(),
			reasoningEffort,
		} as RequestMeta;
		return { devin, codex, ctx, meta, suppression, refreshMisses };
	}
	async function stageModels(
		target: string,
		effort?: string,
		discoveredBeforeRefresh = true,
	) {
		lookup ??= spyOn(devinClient, "getAccount").mockRejectedValue(
			new Error("must not fetch"),
		);
		const { devin, codex, ctx, meta, suppression, refreshMisses } = aliasSetup(
			target,
			effort,
			discoveredBeforeRefresh,
		);
		await initializeRequestRoute(meta, ctx, null, null);
		expect(lookup).not.toHaveBeenCalled();
		const [devinStage, codexStage] = getAliasRoutes(meta) ?? [];
		return {
			devin: devinStage?.target(devin)?.upstreamModel,
			codex: codexStage?.target(codex)?.upstreamModel,
			suppressionReads: suppression.mock.calls.map((call) => call[2]),
			refreshes: refreshMisses.mock.calls.length,
		};
	}
	it("routes the sibling that serves the requested effort", async () => {
		const routed = await stageModels("swe-2-max", "high");
		expect(routed.devin).toBe("swe-2-high");
		// The suppression that gates the stage is the one for the model it sends.
		expect(routed.suppressionReads).toContain("swe-2-high");
		expect(routed.suppressionReads).not.toContain("swe-2-max");
	});
	it("keeps the target as written when no effort was requested", async () => {
		expect((await stageModels("swe-2-max")).devin).toBe("swe-2-max");
	});
	it("keeps the target for an effort outside the vocabulary", async () => {
		expect((await stageModels("swe-2-max", "thinking:2048")).devin).toBe(
			"swe-2-max",
		);
	});
	it("preserves the fast-mode axis while changing the effort", async () => {
		expect((await stageModels("swe-2-max-fast", "high")).devin).toBe(
			"swe-2-high-fast",
		);
	});
	it("falls to the nearest effort below one the family lacks", async () => {
		expect((await stageModels("swe-2-high", "xhigh")).devin).toBe("swe-2-high");
		expect((await stageModels("swe-2-high", "low")).devin).toBe("swe-2-medium");
	});
	it("picks the variant from what the in-stage refresh discovered", async () => {
		// Stored permissions predate the target and carry no variants; only the
		// refresh the stage runs for the miss brings them in.
		const routed = await stageModels("swe-2-max", "high", false);
		expect(routed.refreshes).toBe(1);
		expect(routed.devin).toBe("swe-2-high");
		expect(routed.suppressionReads).toContain("swe-2-high");
		expect(routed.suppressionReads).not.toContain("swe-2-max");
	});
});
