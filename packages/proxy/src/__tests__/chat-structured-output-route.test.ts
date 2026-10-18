import { describe, expect, it } from "bun:test";
import type {
	Account,
	ChatField,
	ModelAlias,
	RequestMeta,
} from "@clankermux/types";
import {
	SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES,
	sdkBridgeRefusedField,
	setChatContext,
} from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import { getAliasRoutes, getResolvedRoute } from "../resolved-route";
import { initializeRequestRoute } from "../routing-service";

const claude = {
	id: "claude-route",
	provider: "anthropic",
	name: "Claude",
	api_key: null,
	custom_endpoint: null,
} as unknown as Account;
const codex = {
	...claude,
	id: "codex-route",
	provider: "codex",
	name: "Codex",
} as Account;

/**
 * `fields` null: a native Messages client on /wire/anthropic, floored to
 * the bridge, whose body the bridge's field policy read.
 */
function setup(
	stages: ModelAlias["targets"],
	fields: ChatField[] | null,
	body: Record<string, unknown> = {},
) {
	const alias: ModelAlias = {
		id: "alias:structured",
		displayName: "Structured",
		revision: 1,
		targets: stages,
	};
	const ctx = {
		dbOps: {
			getAllAccounts: async () => [claude, codex],
			routing: {
				listRules: async () => [],
				isModelSuppressed: async () => false,
			},
			modelAliases: { get: async () => alias },
		},
		modelPermissions: {
			permissions: async (a: Account) => ({
				account_id: a.id,
				scope: modelPermissionScope(a),
				generation: 1,
				completeness: "known-complete",
				discovered_ids:
					a.provider === "codex" ? ["gpt-5.6-sol"] : ["claude-sonnet-5"],
				manual_ids: [],
				last_success_at: Date.now(),
				last_attempt_at: Date.now(),
				last_error: null,
				model_variants: {},
			}),
			refreshMisses: async () => {},
		},
		sdkBridge: { availability: () => ({ state: "available" }) },
	} as unknown as ProxyContext;
	const meta = {
		id: crypto.randomUUID(),
		requestedModel: alias.id,
		path: "/v1/messages",
		method: "POST",
		timestamp: Date.now(),
		officialAnthropicVia: "sdk-bridge",
		headers: new Headers(),
		sdkBridgeRefusedField: sdkBridgeRefusedField(body),
	} as RequestMeta;
	if (fields)
		setChatContext(meta, {
			requirements: { fields },
			defaultMaxTokens: 8192,
			denyDirectOfficialAnthropic: true,
			...(fields.includes("response_format")
				? { structuredOutput: { name: "answer", strict: true } }
				: {}),
		});
	return { ctx, meta };
}

const bridgedThenCodex = [
	{ model: "claude-sonnet-5", accountIds: [claude.id] },
	{ model: "gpt-5.6-sol", accountIds: [codex.id] },
];

const format = { type: "json_schema", schema: { type: "object" } };

describe("a Chat json_schema request's route", () => {
	it("keeps the bridged Claude stage, which serves the schema", async () => {
		const { ctx, meta } = setup(bridgedThenCodex, ["response_format"], {
			output_config: { format },
		});
		await initializeRequestRoute(meta, ctx, null);
		const [claudeStage] = getAliasRoutes(meta) ?? [];
		expect(claudeStage?.admissionError).toBeUndefined();
		expect(getResolvedRoute(meta)).toBe(claudeStage);
		expect(claudeStage?.target(claude)?.upstreamModel).toBe("claude-sonnet-5");
	});
	it("keeps the bridged Claude stage for a request without a schema", async () => {
		const { ctx, meta } = setup(bridgedThenCodex, []);
		await initializeRequestRoute(meta, ctx, null);
		const [claudeStage] = getAliasRoutes(meta) ?? [];
		expect(claudeStage?.admissionError).toBeUndefined();
		expect(getResolvedRoute(meta)).toBe(claudeStage);
	});
	it("routes to the bridge when only the bridge would serve it", async () => {
		const { ctx, meta } = setup(
			[{ model: "claude-sonnet-5", accountIds: [claude.id] }],
			["response_format"],
			{ output_config: { format } },
		);
		await initializeRequestRoute(meta, ctx, null);
		expect(getResolvedRoute(meta)?.accountIds()).toEqual([claude.id]);
	});
});

describe("a native Messages request with a schema and tools", () => {
	const body = {
		output_config: { format },
		tools: [{ name: "read", input_schema: { type: "object" } }],
	};
	it("skips the bridged Claude stage for the Codex one", async () => {
		const { ctx, meta } = setup(bridgedThenCodex, null, body);
		await initializeRequestRoute(meta, ctx, null);
		const [claudeStage, codexStage] = getAliasRoutes(meta) ?? [];
		expect(claudeStage?.admissionError).toMatchObject({
			statusCode: 400,
			param: "output_config.format",
		});
		expect(getResolvedRoute(meta)).toBe(codexStage);
		expect(codexStage?.target(codex)?.upstreamModel).toBe("gpt-5.6-sol");
	});
	it("answers the bridge's 400 naming the field when only the bridge would serve it", async () => {
		const { ctx, meta } = setup(
			[{ model: "claude-sonnet-5", accountIds: [claude.id] }],
			null,
			body,
		);
		await expect(initializeRequestRoute(meta, ctx, null)).rejects.toMatchObject(
			{
				statusCode: 400,
				code: "invalid_request_error",
				param: "output_config.format",
				message: expect.stringContaining("cannot be combined with tools"),
			},
		);
	});
	it("keeps the bridged stage for a schema without tools", async () => {
		const { ctx, meta } = setup(bridgedThenCodex, null, {
			output_config: { format },
			tools: [],
		});
		await initializeRequestRoute(meta, ctx, null);
		const [claudeStage] = getAliasRoutes(meta) ?? [];
		expect(getResolvedRoute(meta)).toBe(claudeStage);
	});
});

describe("a schema too large for Claude Code's argument list", () => {
	const oversized = {
		output_config: {
			format: {
				type: "json_schema",
				schema: { description: "x".repeat(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES) },
			},
		},
	};
	for (const [label, fields] of [
		["a Chat request", ["response_format"]],
		["a native Messages request", null],
	] as const) {
		it(`skips the bridged Claude stage for the Codex one on ${label}`, async () => {
			const { ctx, meta } = setup(
				bridgedThenCodex,
				fields ? [...fields] : null,
				oversized,
			);
			await initializeRequestRoute(meta, ctx, null);
			const [claudeStage, codexStage] = getAliasRoutes(meta) ?? [];
			expect(claudeStage?.admissionError).toMatchObject({
				statusCode: 400,
				param: "output_config.format",
			});
			expect(getResolvedRoute(meta)).toBe(codexStage);
			expect(codexStage?.target(codex)?.upstreamModel).toBe("gpt-5.6-sol");
		});
	}
	it("answers 400 naming the limit when only the bridge would serve it", async () => {
		const { ctx, meta } = setup(
			[{ model: "claude-sonnet-5", accountIds: [claude.id] }],
			["response_format"],
			oversized,
		);
		await expect(initializeRequestRoute(meta, ctx, null)).rejects.toMatchObject(
			{
				statusCode: 400,
				code: "invalid_request_error",
				param: "output_config.format",
				message: expect.stringContaining(
					String(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES),
				),
			},
		);
	});
});
