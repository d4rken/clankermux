import { describe, expect, it, mock } from "bun:test";
import {
	type RequestMeta,
	setChatContext,
	setNativeResponsesMetaContext,
	setSdkBridgeInnerMetaContext,
} from "@clankermux/types";
import type { ProxyContext } from "../handlers";
import {
	type OfficialAnthropicFloorInput,
	officialAnthropicVia,
	resolveOfficialAnthropicFloor,
} from "../official-anthropic-floor";
import { RoutingPolicyError } from "../resolved-route";
import { initializeRequestRoute } from "../routing-service";

const base: OfficialAnthropicFloorInput = {
	adapterFloor: false,
	sdkBridgeInner: false,
	internal: false,
	application: "claude-code",
	harness: "claude-code",
};

describe("officialAnthropicVia", () => {
	const cases: Array<
		[string, Partial<OfficialAnthropicFloorInput>, "direct" | "sdk-bridge"]
	> = [
		["claude-code key + claude-cli UA", {}, "direct"],
		["claude-code key + curl UA", { harness: "curl" }, "sdk-bridge"],
		["claude-code key + no UA", { harness: null }, "sdk-bridge"],
		["pi key + claude-cli UA", { application: "pi" }, "sdk-bridge"],
		[
			"generic key + Go-http-client UA",
			{ application: "generic", harness: "go-http-client" },
			"sdk-bridge",
		],
		["no profile + claude-cli UA", { application: null }, "sdk-bridge"],
		[
			"internal maintenance without a key",
			{ internal: true, application: null, harness: null },
			"direct",
		],
		[
			"bridge inner call",
			{ sdkBridgeInner: true, application: null, harness: "pi" },
			"direct",
		],
		[
			"bridge inner call under an adapter floor",
			{ sdkBridgeInner: true, adapterFloor: true },
			"direct",
		],
		[
			"Responses or Chat on a claude-code key + claude-cli UA",
			{ adapterFloor: true },
			"sdk-bridge",
		],
	];
	for (const [label, input, expected] of cases)
		it(`${label} → ${expected}`, () => {
			expect(officialAnthropicVia({ ...base, ...input })).toBe(expected);
		});
});

describe("resolveOfficialAnthropicFloor", () => {
	function makeCtx(
		pin: Record<string, unknown> | null = {
			pinnedAccountId: null,
			pinnedProviders: null,
			malformed: false,
			application: "claude-code",
		},
	) {
		const getApiKeyPin = mock(async () => pin);
		const ctx = { dbOps: { getApiKeyPin } } as unknown as ProxyContext;
		return { ctx, getApiKeyPin };
	}

	function meta(overrides: Partial<RequestMeta> = {}): RequestMeta {
		return {
			id: crypto.randomUUID(),
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			clientHarness: "claude-code",
			...overrides,
		};
	}

	const resolve = (m: RequestMeta, ctx: ProxyContext, body: unknown = {}) =>
		resolveOfficialAnthropicFloor(m, ctx, "key-1", new Headers(), body);

	it("reads the key once and keeps its application and destinations", async () => {
		const { ctx, getApiKeyPin } = makeCtx();
		const m = meta();

		await resolve(m, ctx);

		expect(m.officialAnthropicVia).toBe("direct");
		expect(m.clientApplication).toBe("claude-code");
		expect(m.pin).toEqual({
			accountId: null,
			providers: null,
			excludedProviders: null,
		});
		expect(getApiKeyPin).toHaveBeenCalledTimes(1);
	});

	it("is the read routing reuses", async () => {
		const { ctx, getApiKeyPin } = makeCtx();
		const m = meta({ requestedModel: "claude-sonnet-4-5" });
		await resolve(m, ctx);
		// Routing fails on the empty context after its key read, which is the
		// point: the read it would have made has already happened.
		await initializeRequestRoute(m, ctx, "key-1").catch(() => {});

		expect(getApiKeyPin).toHaveBeenCalledTimes(1);
	});

	it("floors a key without a profile, and computes the refused field", async () => {
		const { ctx } = makeCtx({
			pinnedAccountId: null,
			pinnedProviders: null,
			malformed: false,
		});
		const m = meta();

		await resolve(m, ctx, { stop_sequences: ["END"] });

		expect(m.clientApplication).toBeNull();
		expect(m.officialAnthropicVia).toBe("sdk-bridge");
		expect(m.sdkBridgeRefusedField?.field).toBe("stop_sequences");
	});

	it("names no refused field on a direct request", async () => {
		const { ctx } = makeCtx();
		const m = meta();

		await resolve(m, ctx, { stop_sequences: ["END"] });

		expect(m.officialAnthropicVia).toBe("direct");
		expect(m.sdkBridgeRefusedField).toBeNull();
	});

	it("fails closed on a key that is gone or malformed", async () => {
		for (const pin of [
			null,
			{ pinnedAccountId: null, pinnedProviders: null, malformed: true },
		]) {
			const { ctx } = makeCtx(pin);
			await expect(resolve(meta(), ctx)).rejects.toBeInstanceOf(
				RoutingPolicyError,
			);
		}
	});

	it("reads nothing for internal maintenance, which goes direct", async () => {
		const { ctx, getApiKeyPin } = makeCtx();
		const m = meta({ internal: true, clientHarness: null });

		await resolveOfficialAnthropicFloor(m, ctx, null, new Headers(), {});

		expect(m.officialAnthropicVia).toBe("direct");
		expect(m.clientApplication).toBeNull();
		expect(getApiKeyPin).not.toHaveBeenCalled();
	});

	it("reads nothing for a bridge inner call, which goes direct", async () => {
		const { ctx, getApiKeyPin } = makeCtx();
		const m = meta({ clientHarness: "pi" });
		setSdkBridgeInnerMetaContext(m, {
			turnId: "turn-1",
			plan: {
				turnId: "turn-1",
				routeSnapshot: null,
				candidates: [],
				preferredAccountId: "a",
				apiKeyId: "key-1",
				apiKeyName: null,
			},
			apiKeyId: "key-1",
			apiKeyName: null,
			clientHarness: "pi",
			project: null,
			deadlineAt: Date.now() + 60_000,
		});

		await resolve(m, ctx, { stop_sequences: ["END"] });

		expect(m.officialAnthropicVia).toBe("direct");
		expect(m.sdkBridgeRefusedField).toBeNull();
		expect(getApiKeyPin).not.toHaveBeenCalled();
	});

	it("keeps the Responses and Chat floors on a Claude Code key and user agent", async () => {
		const responses = meta();
		setNativeResponsesMetaContext(responses, {
			nativeBody: "{}",
			denyDirectOfficialAnthropic: true,
		});
		const chat = meta();
		setChatContext(chat, {
			requirements: { fields: [] },
			defaultMaxTokens: 1024,
			denyDirectOfficialAnthropic: true,
		});

		for (const m of [responses, chat]) {
			await resolve(m, makeCtx().ctx);
			expect(m.officialAnthropicVia).toBe("sdk-bridge");
		}
	});
});
