import { afterEach, describe, expect, it } from "bun:test";
import type {
	SdkBridgeInnerContext,
	SdkBridgeInnerOutcome,
} from "@clankermux/types";
import { InnerListener } from "../inner-listener";
import { fakeInner, MODEL, makePlan, silentLog } from "./fixtures/fake-sdk";

function context(
	outcomes: SdkBridgeInnerOutcome[] = [],
): SdkBridgeInnerContext {
	const plan = makePlan();
	return {
		turnId: plan.turnId,
		plan,
		apiKeyId: "key-1",
		apiKeyName: "key one",
		clientHarness: "pi",
		project: "proj",
		deadlineAt: Date.now() + 60_000,
		onInnerOutcome: (o) => outcomes.push(o),
	};
}

function call(
	listener: InnerListener,
	token: string | null,
	init: {
		path?: string;
		method?: string;
		model?: string;
		headers?: Record<string, string>;
	} = {},
) {
	const method = init.method ?? "POST";
	return listener.handle(
		new Request(`http://127.0.0.1:1${init.path ?? "/v1/messages?beta=true"}`, {
			method,
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...init.headers,
			},
			body:
				method === "POST"
					? JSON.stringify({ model: init.model ?? MODEL, messages: [] })
					: undefined,
		}),
	);
}

describe("InnerListener", () => {
	let listener: InnerListener | null = null;
	afterEach(() => listener?.stop());

	function setup() {
		const inner = fakeInner();
		listener = new InnerListener({
			dispatchInner: inner.dispatch,
			log: silentLog,
		});
		return { inner, listener };
	}

	it("answers the CLI's connectivity probe without dispatching", async () => {
		const { inner, listener } = setup();
		const res = await call(listener, null, {
			method: "HEAD",
			path: "/api/hello",
		});
		expect(res.status).toBe(204);
		expect(inner.calls).toHaveLength(0);
	});

	it("dispatches an authorized call with the turn's context and no credentials", async () => {
		const { inner, listener } = setup();
		const ctx = context();
		const { token } = listener.register(ctx);
		const res = await call(listener, token, {
			headers: {
				"x-api-key": "sk-ant-client",
				"x-clankermux-account-id": "acct-other",
				"x-clankermux-project": "other-project",
				"anthropic-beta": "oauth-2025-04-20",
			},
		});
		expect(res.status).toBe(200);
		expect(inner.calls).toHaveLength(1);
		const sent = inner.calls[0];
		expect(sent?.req.headers.get("authorization")).toBeNull();
		expect(sent?.req.headers.get("x-api-key")).toBeNull();
		expect(sent?.req.headers.get("x-clankermux-account-id")).toBeNull();
		expect(sent?.req.headers.get("x-clankermux-project")).toBeNull();
		expect(sent?.req.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(new URL(sent?.req.url ?? "").pathname).toBe("/v1/messages");
		expect(sent?.ctx.plan).toBe(ctx.plan);
		expect(sent?.ctx.project).toBe("proj");
	});

	it("hands every call the same immutable context", async () => {
		const { inner, listener } = setup();
		const { token } = listener.register(context());
		await call(listener, token);
		await call(listener, token, { path: "/v1/messages/count_tokens" });
		const [a, b] = inner.calls;
		expect(a?.ctx).toBe(b?.ctx as SdkBridgeInnerContext);
		expect(Object.isFrozen(a?.ctx)).toBe(true);
		expect(() => {
			(a?.ctx as { project: string | null }).project = "widened";
		}).toThrow();
		expect(Object.isFrozen(a?.ctx.plan.candidates)).toBe(true);
	});

	it("refuses forged, foreign and revoked tokens", async () => {
		const { inner, listener } = setup();
		const other = new InnerListener({
			dispatchInner: inner.dispatch,
			log: silentLog,
		});
		const foreign = other.register(context()).token;
		other.stop();
		const registration = listener.register(context());
		expect((await call(listener, null)).status).toBe(401);
		expect((await call(listener, "cmxsdk_forged_token")).status).toBe(401);
		expect((await call(listener, foreign)).status).toBe(401);
		expect((await call(listener, `${registration.token}x`)).status).toBe(401);
		registration.revoke();
		expect((await call(listener, registration.token)).status).toBe(401);
		expect(inner.calls).toHaveLength(0);
	});

	it("refuses a model the plan does not target and reports it to the turn", async () => {
		const { inner, listener } = setup();
		const outcomes: SdkBridgeInnerOutcome[] = [];
		const { token } = listener.register(context(outcomes));
		const res = await call(listener, token, { model: "claude-opus-5" });
		expect(res.status).toBe(400);
		expect(inner.calls).toHaveLength(0);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]?.status).toBe(400);
	});

	it("serves only the messages endpoints", async () => {
		const { inner, listener } = setup();
		const { token } = listener.register(context());
		expect(
			(await call(listener, token, { path: "/v1/models", method: "GET" }))
				.status,
		).toBe(404);
		expect((await call(listener, token, { path: "/v1/complete" })).status).toBe(
			404,
		);
		expect(
			(await call(listener, token, { path: "/api/oauth/usage", method: "GET" }))
				.status,
		).toBe(404);
		expect(inner.calls).toHaveLength(0);
	});

	it("turns an inner 403 into a 400 for Claude Code, keeping the message", async () => {
		const { inner, listener } = setup();
		inner.respond = () =>
			Response.json(
				{
					type: "error",
					error: { type: "permission_error", message: "model not permitted" },
				},
				{ status: 403 },
			);
		const { token } = listener.register(context());
		const res = await call(listener, token);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			type: "error",
			error: { type: "invalid_request_error", message: "model not permitted" },
		});
	});

	it("listens on loopback only", () => {
		const { listener } = setup();
		expect(listener.ensureStarted()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});
});
