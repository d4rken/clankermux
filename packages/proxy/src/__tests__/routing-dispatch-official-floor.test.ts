/**
 * The last gate before the wire sends a request directly to an official
 * Anthropic account only when the floor said "direct". The bridge's own
 * transport is the other way there.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type {
	Account,
	AccountModelPermissions,
	RequestMeta,
} from "@clankermux/types";
import { setChatContext } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import {
	buildResolvedRoute,
	installResolvedRoute,
	RoutingPolicyError,
} from "../resolved-route";
import { sendAuthorizedRequest } from "../routing-dispatch";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";

const MODEL = "claude-haiku-4-5";

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			new Response(JSON.stringify({ type: "message" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch,
	);
});
afterEach(() => {
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

function setup(
	account: Account,
	via: RequestMeta["officialAnthropicVia"],
	chat = false,
) {
	const ctx = makeContext([account]);
	ctx.modelPermissions = {
		permissions: async () => permitted(account),
	} as never;
	const recordAttempt = mock(async (_attempt: unknown) => {});
	(ctx.dbOps as { routing: unknown }).routing = {
		recordAttempt,
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
		...(via ? { officialAnthropicVia: via } : {}),
	} as RequestMeta;
	if (chat)
		setChatContext(meta, {
			requirements: { fields: [] },
			defaultMaxTokens: 8192,
			denyDirectOfficialAnthropic: true,
		});
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
	return { ctx, meta, request, recordAttempt };
}

describe("a send to an official Anthropic account", () => {
	for (const via of ["sdk-bridge", undefined] as const)
		it(`is refused and recorded when the floor said ${via ?? "nothing"}`, async () => {
			const account = makeAccount({ provider: "anthropic" });
			const { ctx, meta, request, recordAttempt } = setup(account, via);
			await expect(
				sendAuthorizedRequest(request, account, meta, ctx),
			).rejects.toBeInstanceOf(RoutingPolicyError);
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(recordAttempt).toHaveBeenCalledWith(
				expect.objectContaining({ kind: "local_reject", status: 403 }),
			);
		});

	it("goes out when the floor said direct", async () => {
		const account = makeAccount({ provider: "claude-console-api" });
		const { ctx, meta, request } = setup(account, "direct");
		const response = await sendAuthorizedRequest(request, account, meta, ctx);
		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("is still refused for Chat when the floor said direct", async () => {
		const account = makeAccount({ provider: "anthropic" });
		const { ctx, meta, request } = setup(account, "direct", true);
		await expect(
			sendAuthorizedRequest(request, account, meta, ctx),
		).rejects.toBeInstanceOf(RoutingPolicyError);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("goes through the bridge's transport under the floor", async () => {
		const account = makeAccount({ provider: "anthropic" });
		const { ctx, meta, request } = setup(account, "sdk-bridge");
		const transport = mock(async () => new Response("{}"));
		const response = await sendAuthorizedRequest(
			request,
			account,
			meta,
			ctx,
			undefined,
			undefined,
			null,
			undefined,
			transport,
		);
		expect(response.status).toBe(200);
		expect(transport).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

it("leaves a send to any other provider to the floor's absence", async () => {
	const account = makeAccount({ provider: "zai", api_key: "k" });
	const { ctx, meta, request } = setup(account, undefined);
	const response = await sendAuthorizedRequest(request, account, meta, ctx);
	expect(response.status).toBe(200);
});
