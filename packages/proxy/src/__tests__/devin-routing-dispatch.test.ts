import { afterEach, expect, it, mock, spyOn } from "bun:test";
import {
	devinClient,
	getDevinRequestProvenance,
	getProvider,
} from "@clankermux/providers";
import type { RequestMeta } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import { buildResolvedRoute, installResolvedRoute } from "../resolved-route";
import { sendAuthorizedRequest } from "../routing-dispatch";
import { devinInfo, devinReply } from "./devin-fixtures";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const originalFetch = globalThis.fetch;
let auth: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
	globalThis.fetch = originalFetch;
	auth?.mockRestore();
});
async function setup(quota = false, path = "/v1/messages") {
	const account = makeAccount({
		provider: "devin",
		api_key: "private-session",
		auto_pause_on_overage_enabled: true,
	});
	const ctx = makeContext([account]);
	const permissions = {
		account_id: account.id,
		scope: modelPermissionScope(account),
		generation: 1,
		completeness: "known-complete" as const,
		discovered_ids: ["swe-2-high"],
		manual_ids: [],
		last_success_at: Date.now(),
		last_attempt_at: Date.now(),
		last_error: null,
	};
	ctx.modelPermissions = { permissions: async () => permissions } as never;
	ctx.dbOps.routing = {
		recordAttempt: mock(async () => {}),
		finishAttempt: mock(async () => {}),
		isModelSuppressed: mock(async () => false),
	} as never;
	ctx.dbOps.getAccount = mock(async () => account);
	const meta = {
		id: crypto.randomUUID(),
		method: "POST",
		path,
		timestamp: Date.now(),
		requestedModel: "swe-2-high",
	} as RequestMeta;
	installResolvedRoute(
		meta,
		buildResolvedRoute({
			accounts: [account],
			rules: [],
			requestedModel: "swe-2-high",
			apiKeyId: null,
			pin: null,
			permissions: new Map([[account.id, permissions]]),
		}),
	);
	const info = devinInfo();
	if (quota)
		info.usage.daily = { utilization: 100, resetAt: Date.now() + 60000 };
	auth = spyOn(devinClient, "getAccount").mockResolvedValue(info);
	const provider = getProvider("devin");
	if (!provider?.transformRequestBody)
		throw new Error("Devin provider missing");
	const input = new Request(provider.buildUrl(path, "", account), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "swe-2-high",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	});
	const request = await provider.transformRequestBody(input, account);
	const proof = getDevinRequestProvenance(request);
	if (!proof) throw new Error("Devin request provenance missing");
	return {
		account,
		ctx,
		meta,
		request,
		proof,
	};
}
it("authorizes provider-generated binary bytes after request cloning", async () => {
	const { account, ctx, meta, request, proof } = await setup();
	globalThis.fetch = mock(async () => devinReply()) as never;
	const response = await sendAuthorizedRequest(
		request.clone(),
		account,
		meta,
		ctx,
		undefined,
		undefined,
		proof,
	);
	await response.arrayBuffer();
	expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	expect(ctx.dbOps.routing.recordAttempt).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: "upstream_send",
			resolved_model: "swe-2-high",
			outgoing_model: "swe-2-high",
		}),
	);
});
for (const change of ["body", "url", "credential", "model", "missing-proof"]) {
	it(`rejects changed Devin ${change} before network dispatch`, async () => {
		const { account, ctx, meta, request, proof } = await setup();
		globalThis.fetch = mock(async () => devinReply()) as never;
		let outgoing = request.clone();
		let provenance: typeof proof | null = proof;
		if (change === "body")
			outgoing = new Request(request.url, {
				method: "POST",
				headers: request.headers,
				body: new Uint8Array([1, 2, 3]),
			});
		if (change === "url")
			outgoing = new Request("https://other.devin.ai/send", {
				method: "POST",
				headers: request.headers,
				body: await request.clone().arrayBuffer(),
			});
		if (change === "credential") account.api_key = "replacement";
		if (change === "model")
			provenance = { ...proof, model: "different-model" } as typeof proof;
		if (change === "missing-proof") provenance = null;
		await expect(
			sendAuthorizedRequest(
				outgoing,
				account,
				meta,
				ctx,
				undefined,
				undefined,
				provenance,
			),
		).rejects.toThrow();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
}
it("preserves provider-local quota failures without sending inference", async () => {
	const { account, ctx, meta, request, proof } = await setup(true);
	globalThis.fetch = mock(async () => {
		throw new Error("unexpected network");
	}) as never;
	const response = await sendAuthorizedRequest(
		request.clone(),
		account,
		meta,
		ctx,
		undefined,
		undefined,
		proof,
	);
	expect(response.status).toBe(429);
	await response.text();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(ctx.dbOps.routing.recordAttempt).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "local_reject", outgoing_model: null }),
	);
});
it("does not accept synthetic status header tampering", async () => {
	const { account, ctx, meta, request, proof } = await setup(true);
	const headers = new Headers(request.headers);
	headers.set("x-clankermux-synthetic-status", "200");
	const outgoing = new Request(request.url, {
		method: request.method,
		headers,
		body: await request.clone().arrayBuffer(),
	});
	globalThis.fetch = mock(async () => devinReply()) as never;
	await expect(
		sendAuthorizedRequest(
			outgoing,
			account,
			meta,
			ctx,
			undefined,
			undefined,
			proof,
		),
	).rejects.toThrow();
	expect(globalThis.fetch).not.toHaveBeenCalled();
});
