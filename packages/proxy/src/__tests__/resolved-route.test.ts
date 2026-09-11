import { describe, expect, it } from "bun:test";
import type { Account, RequestMeta, RoutingRule } from "@clankermux/types";
import {
	buildResolvedRoute,
	enforceOutgoingModel,
	getAttemptTarget,
	installResolvedRoute,
} from "../resolved-route";

const account = (id: string, provider: string) =>
	({ id, provider, name: id }) as Account;
const a = account("a", "anthropic"),
	c = account("c", "codex"),
	o = account("o", "openrouter");
const rule: RoutingRule = {
	id: "r",
	name: "Experiment",
	position: 0,
	enabled: true,
	match_api_key_id: null,
	match_model_kind: "any",
	match_model_value: null,
	pool_kind: "provider",
	pool_provider: "codex",
	pool_account_ids: null,
	target_kind: "literal",
	target_model: "gpt-6-astra",
};
const known = {
	completeness: "known-complete" as const,
	discovered_ids: ["gpt-6-astra", "claude-fable-5-1"],
	manual_ids: [],
};
const build = (patch: Partial<Parameters<typeof buildResolvedRoute>[0]> = {}) =>
	buildResolvedRoute({
		accounts: [a, c, o],
		rules: [rule],
		requestedModel: "claude-fable-5-1",
		apiKeyId: "key",
		pin: { accountId: null, providers: ["codex", "openrouter"] },
		permissions: new Map([
			["a", known],
			["c", known],
			["o", known],
		]),
		...patch,
	});
describe("resolved route authority", () => {
	it("intersects every destination restriction before admission", () => {
		const route = build();
		expect(route.accountIds()).toEqual(["c"]);
		expect(() => build({ forcedAccountId: "a" })).toThrow();
		expect(() =>
			build({ forcedAccountId: "c", headerAccountId: "o" }),
		).toThrow();
		expect(() => build({ pin: { accountId: "o", providers: null } })).toThrow();
		expect(() =>
			build({
				rules: [],
				pin: { accountId: "a", providers: null },
				excludeOfficialAnthropic: true,
			}),
		).toThrow();
	});
	it("requires runtime request authorization and keeps targets fixed across edits", () => {
		const meta = {} as RequestMeta;
		expect(() => getAttemptTarget(meta, c)).toThrow();
		const input = { ...rule };
		const route = build({ rules: [input] });
		installResolvedRoute(meta, route);
		input.target_model = "changed";
		expect(getAttemptTarget(meta, c).upstreamModel).toBe("gpt-6-astra");
		expect(() => getAttemptTarget(meta, o)).toThrow();
		expect(() =>
			getAttemptTarget(meta, { ...c, provider: "anthropic" }),
		).toThrow();
		expect(() => installResolvedRoute(meta, build())).toThrow();
	});
	it("does not fall through a winning empty rule to a later matching rule", () => {
		expect(() =>
			build({
				rules: [
					rule,
					{ ...rule, id: "late", position: 1, pool_provider: "openrouter" },
				],
				permissions: new Map([["c", { ...known, discovered_ids: [] }]]),
			}),
		).toThrow();
	});
	it("asserts the final serialized model and rejects model-switch escape fields", async () => {
		const request = (body: unknown) =>
			new Request("https://example.test/v1/messages", {
				method: "POST",
				body: JSON.stringify(body),
			});
		expect(
			await enforceOutgoingModel(
				request({ model: "gpt-6-astra", custom: true }),
				"gpt-6-astra",
			),
		).toBe("gpt-6-astra");
		await expect(
			enforceOutgoingModel(request({ model: "other" }), "gpt-6-astra"),
		).rejects.toThrow();
		for (const fields of [
			{ models: ["other"] },
			{ fallbacks: ["other"] },
			{ route: "fallback" },
		])
			await expect(
				enforceOutgoingModel(
					request({ model: "gpt-6-astra", ...fields }),
					"gpt-6-astra",
				),
			).rejects.toThrow();
	});
});

describe("Chat capability boundary", () => {
	it("filters only within pinned permitted targets and freezes the field requirements", () => {
		const fields = ["temperature"];
		const route = build({
			rules: [],
			requestedModel: "gpt-6-astra",
			chatRequirements: { fields },
		});
		expect(route.accountIds()).toEqual(["o"]);
		fields.length = 0;
		expect(route.accountIds()).toEqual(["o"]);
		expect(JSON.parse(route.snapshot).chatRequirements.fields).toEqual([
			"temperature",
		]);
		expect(route.target(c)).toBeNull();
	});
	it("returns a field-specific capability error for a Codex-only pin", () => {
		try {
			build({ chatRequirements: { fields: ["max_tokens"] } });
			throw new Error("Expected rejection");
		} catch (error) {
			expect(error).toMatchObject({
				statusCode: 400,
				code: "unsupported_parameter",
				param: "max_tokens",
			});
		}
	});
	it("does not classify a permission or pin conflict as a field error", () => {
		expect(() =>
			build({
				pin: { accountId: "o", providers: null },
				chatRequirements: { fields: ["max_tokens"] },
			}),
		).toThrow("No permitted");
	});
	it("rejects unsupported providers even without official-Anthropic exclusion headers", () => {
		expect(() =>
			build({
				rules: [],
				pin: { accountId: "a", providers: null },
				chatRequirements: { fields: [] },
			}),
		).toThrow("Chat Completions");
	});
});
