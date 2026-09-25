/**
 * Every upstream send to an official Anthropic account holds a quota-use mark
 * from the send until its body is over, so the usage cache never trusts a poll
 * that landed while the account was consuming.
 */
import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@clankermux/providers";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
} from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import { buildResolvedRoute, installResolvedRoute } from "../resolved-route";
import { sendAuthorizedRequest } from "../routing-dispatch";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const MODEL = "claude-haiku-4-5";

let fetchSpy: ReturnType<typeof spyOn>;
let begin: ReturnType<typeof spyOn>;
let end: ReturnType<typeof mock>;
let fetchFails = false;

beforeEach(() => {
	fetchFails = false;
	end = mock(() => {});
	begin = spyOn(usageCache, "beginQuotaUse").mockImplementation(() => end);
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
		if (fetchFails) throw new Error("connection reset");
		return new Response(JSON.stringify({ type: "message" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch);
});
afterEach(() => {
	begin.mockRestore();
	fetchSpy.mockRestore();
});

function permitted(account: Account): AccountModelPermissions {
	return {
		account_id: account.id,
		scope: modelPermissionScope(account),
		generation: 1,
		completeness: "known-complete",
		discovered_ids: [MODEL],
		manual_ids: [],
		last_success_at: 1,
		last_attempt_at: 1,
		last_error: null,
	};
}

async function send(account: Account): Promise<Response> {
	const ctx = makeContext([account]);
	ctx.modelPermissions = {
		permissions: async () => permitted(account),
	} as never;
	(ctx.dbOps as { routing: unknown }).routing = {
		recordAttempt: mock(async () => {}),
		finishAttempt: mock(async () => {}),
		isModelSuppressed: mock(async () => false),
		suppressModel: mock(async () => {}),
	};
	ctx.dbOps.getAccount = mock(async () => account);
	const meta = {
		id: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestedModel: MODEL,
	} as RequestMeta;
	installResolvedRoute(
		meta,
		buildResolvedRoute({
			accounts: [account],
			rules: [],
			requestedModel: MODEL,
			apiKeyId: null,
			pin: null,
			permissions: new Map([[account.id, permitted(account)]]),
		}),
	);
	// Never the real endpoint: fetch is stubbed above.
	const request = new Request("https://upstream.invalid/v1/messages", {
		method: "POST",
		body: JSON.stringify({ model: MODEL, messages: [] }),
	});
	return sendAuthorizedRequest(request, account, meta, ctx);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

it("holds the mark from the send until the body has been read", async () => {
	const account = makeAccount({ provider: "anthropic" });
	const response = await send(account);

	expect(begin).toHaveBeenCalledWith(account.id);
	expect(end).not.toHaveBeenCalled();
	await response.text();
	await tick();
	expect(end).toHaveBeenCalledTimes(1);
});

it("ends the mark when the send itself fails", async () => {
	fetchFails = true;
	const account = makeAccount({ provider: "anthropic" });
	await send(account).catch(() => {});

	expect(begin).toHaveBeenCalledTimes(1);
	expect(end).toHaveBeenCalledTimes(1);
});

it("marks nothing for another provider or a custom endpoint", async () => {
	await (await send(makeAccount({ provider: "zai", api_key: "k" }))).text();
	await (
		await send(
			makeAccount({
				provider: "anthropic",
				custom_endpoint: "https://gateway.invalid",
			}),
		)
	).text();

	expect(begin).not.toHaveBeenCalled();
});
