import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { devinClient } from "@clankermux/providers";
import type { Account, RequestMeta } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import { parseReasoningEffort } from "../reasoning-effort";
import { getResolvedRoute } from "../resolved-route";
import { initializeRequestRoute } from "../routing-service";
import { devinInfo } from "./devin-fixtures";

let lookup: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	lookup?.mockRestore();
	lookup = undefined;
});
function setup(model = "claude-sonnet-4-5", permitted = ["swe-2-high"]) {
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
it("resolves Devin defaults before permissions and suppression and freezes the concrete target", async () => {
	lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
	const { account, ctx, meta, suppression, refresh } = setup();
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).target(account)?.upstreamModel).toBe(
		"swe-2-high",
	);
	expect(refresh).not.toHaveBeenCalled();
	expect(suppression.mock.calls[0]?.[2]).toBe("swe-2-high");
});
it("requires concrete permission even if the generic Devin alias is allowed", async () => {
	lookup = spyOn(devinClient, "getAccount").mockResolvedValue(devinInfo());
	const { ctx, meta, refresh } = setup("swe-2", ["swe-2"]);
	await expect(initializeRequestRoute(meta, ctx, null, null)).rejects.toThrow();
	expect(refresh).toHaveBeenCalledTimes(1);
});
it("does not fall back from an unavailable SWE-2 alias to another model family", async () => {
	const info = devinInfo();
	const model = info.models[0];
	if (!model) throw new Error("Missing test model");
	model.disabled = true;
	info.models.push({
		...model,
		id: "swe-1.6",
		name: "SWE1.6",
		disabled: false,
	});
	lookup = spyOn(devinClient, "getAccount").mockResolvedValue(info);
	const { ctx, meta } = setup("swe-2", ["swe-2-high", "swe-1.6"]);
	await expect(initializeRequestRoute(meta, ctx, null, null)).rejects.toThrow(
		"enabled SWE-2 model",
	);
});
it("leaves explicit concrete Devin requests unchanged without alias metadata fetch", async () => {
	lookup = spyOn(devinClient, "getAccount").mockRejectedValue(
		new Error("must not fetch"),
	);
	const { account, ctx, meta } = setup("swe-1.6", ["swe-1.6"]);
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).target(account)?.upstreamModel).toBe("swe-1.6");
	expect(lookup).not.toHaveBeenCalled();
});

it("discards alias resolution when credentials change during the metadata await", async () => {
	const { account, ctx, meta } = setup("swe-2");
	lookup = spyOn(devinClient, "getAccount").mockImplementation(async () => {
		account.api_key = "replacement";
		return devinInfo();
	});
	await expect(initializeRequestRoute(meta, ctx, null, null)).rejects.toThrow();
});

it.each([
	{ reasoning_effort: "max" },
	{
		output_config: { effort: "max" },
		thinking: { type: "enabled", budget_tokens: 100 },
	},
])("selects the permitted concrete Devin effort before freezing route (%j)", async (body) => {
	const info = devinInfo();
	const model = info.models[0];
	if (!model) throw new Error("Missing test model");
	info.models.push({
		...model,
		id: "swe-2-max",
		name: "SWE-2 Max",
		effort: "max",
		defaultInFamily: false,
	});
	lookup = spyOn(devinClient, "getAccount").mockResolvedValue(info);
	const { account, ctx, meta } = setup("swe-2", ["swe-2-high", "swe-2-max"]);
	meta.reasoningEffort = parseReasoningEffort(body);
	await initializeRequestRoute(meta, ctx, null, null);
	expect(getResolvedRoute(meta).target(account)?.upstreamModel).toBe(
		"swe-2-max",
	);
});
