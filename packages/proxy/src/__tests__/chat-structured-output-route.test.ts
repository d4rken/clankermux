import { describe, expect, it } from "bun:test";
import type {
	Account,
	ChatField,
	ModelAlias,
	RequestMeta,
} from "@clankermux/types";
import { setChatContext } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
import type { ProxyContext } from "../handlers/proxy-types";
import {
	ChatCapabilityError,
	getAliasRoutes,
	getResolvedRoute,
} from "../resolved-route";
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

function setup(stages: ModelAlias["targets"], fields: ChatField[]) {
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
	} as RequestMeta;
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

describe("a Chat json_schema request's route", () => {
	it("skips the bridged Claude stage for the Codex one", async () => {
		const { ctx, meta } = setup(bridgedThenCodex, ["response_format"]);
		await initializeRequestRoute(meta, ctx, null);
		const [claudeStage, codexStage] = getAliasRoutes(meta) ?? [];
		expect(claudeStage?.admissionError).toBeInstanceOf(ChatCapabilityError);
		expect(claudeStage?.admissionError).toMatchObject({
			statusCode: 400,
			code: "unsupported_parameter",
			param: "response_format",
		});
		expect(getResolvedRoute(meta)).toBe(codexStage);
		expect(codexStage?.target(codex)?.upstreamModel).toBe("gpt-5.6-sol");
	});
	it("keeps the bridged Claude stage for a request without a schema", async () => {
		const { ctx, meta } = setup(bridgedThenCodex, []);
		await initializeRequestRoute(meta, ctx, null);
		const [claudeStage] = getAliasRoutes(meta) ?? [];
		expect(claudeStage?.admissionError).toBeUndefined();
		expect(getResolvedRoute(meta)).toBe(claudeStage);
	});
	it("answers a 400 naming response_format when only the bridge would serve it", async () => {
		const { ctx, meta } = setup(
			[{ model: "claude-sonnet-5", accountIds: [claude.id] }],
			["response_format"],
		);
		await expect(initializeRequestRoute(meta, ctx, null)).rejects.toMatchObject(
			{
				statusCode: 400,
				code: "unsupported_parameter",
				param: "response_format",
			},
		);
	});
});
