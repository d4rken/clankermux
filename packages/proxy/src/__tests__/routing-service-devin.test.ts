import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { devinClient } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { setChatContext } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import { getResolvedRoute } from "../resolved-route";
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
		completeness: "known-complete",
		discovered_ids: ["swe-2", "swe-2-high"],
		manual_ids: [],
		fetched_at: Date.now(),
		error: null,
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
