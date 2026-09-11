import { describe, expect, it } from "bun:test";
import type { Account, RequestMeta, RoutingRule } from "@clankermux/types";
import { modelPermissionScope } from "../account-model-permissions";
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

it("freezes a Devin alias to its permitted concrete account model and suppresses that pair", () => {
	const devin = account("d", "devin");
	const permissions = new Map([
		["d", { ...known, discovered_ids: ["swe-2-high"] }],
	]);
	const canonicalTargets = new Map([
		["d", { upstreamModel: "swe-2-high", scope: modelPermissionScope(devin) }],
	]);
	const input = {
		accounts: [devin],
		rules: [],
		requestedModel: "claude-sonnet-4-5",
		apiKeyId: null,
		pin: null,
		permissions,
		canonicalTargets,
	};
	const route = buildResolvedRoute(input);
	expect(route.target(devin)?.upstreamModel).toBe("swe-2-high");
	canonicalTargets.set("d", {
		upstreamModel: "swe-2-max",
		scope: modelPermissionScope(devin),
	});
	expect(route.target(devin)?.upstreamModel).toBe("swe-2-high");
	expect(() => buildResolvedRoute(input)).toThrow();
	expect(() =>
		buildResolvedRoute({ ...input, canonicalTargets: new Map() }),
	).toThrow();
	expect(() =>
		buildResolvedRoute({
			...input,
			canonicalTargets: new Map([
				[
					"d",
					{ upstreamModel: "swe-2-high", scope: modelPermissionScope(devin) },
				],
			]),
			suppressedPairs: new Set([JSON.stringify(["d", "swe-2-high"])]),
		}),
	).toThrow();
	expect(() =>
		buildResolvedRoute({
			...input,
			canonicalTargets: new Map([
				[
					"d",
					{ upstreamModel: "swe-2-high", scope: modelPermissionScope(devin) },
				],
			]),
			permissions: new Map([["d", { ...known, discovered_ids: ["swe-2"] }]]),
		}),
	).toThrow();
});
it("does not change a concrete Devin target using an alias resolution", () => {
	const devin = account("d", "devin");
	const route = buildResolvedRoute({
		accounts: [devin],
		rules: [],
		requestedModel: "swe-1.6",
		apiKeyId: null,
		pin: null,
		permissions: new Map([["d", { ...known, discovered_ids: ["swe-1.6"] }]]),
		canonicalTargets: new Map([
			[
				"d",
				{ upstreamModel: "swe-2-high", scope: modelPermissionScope(devin) },
			],
		]),
	});
	expect(route.target(devin)?.upstreamModel).toBe("swe-1.6");
});

it("discards a Devin canonical target when credentials changed during metadata resolution", () => {
	const devin = { ...account("d", "devin"), api_key: "new-session" };
	expect(() =>
		buildResolvedRoute({
			accounts: [devin],
			rules: [],
			requestedModel: "swe-2",
			apiKeyId: null,
			pin: null,
			permissions: new Map([
				["d", { ...known, discovered_ids: ["swe-2-high"] }],
			]),
			canonicalTargets: new Map([
				[
					"d",
					{
						upstreamModel: "swe-2-high",
						scope: modelPermissionScope({ ...devin, api_key: "old-session" }),
					},
				],
			]),
		}),
	).toThrow();
});
