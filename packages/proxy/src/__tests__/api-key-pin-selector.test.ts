import { describe, expect, it, mock } from "bun:test";
import type { RequestMeta } from "@clankermux/types";
import { makeAccount, makeContext } from "./fixtures/proxy-terminal-harness";
import { selectAccountsForRequest } from "./fixtures/routing-harness";

const a = makeAccount({ id: "anthropic", provider: "anthropic" }),
	c = makeAccount({ id: "codex", provider: "codex" }),
	o = makeAccount({ id: "openrouter", provider: "openrouter" });
const meta = (patch: Partial<RequestMeta> = {}): RequestMeta => ({
	id: crypto.randomUUID(),
	method: "POST",
	path: "/v1/messages",
	timestamp: Date.now(),
	requestedModel: "claude-fable-5-1",
	...patch,
});
describe("API key destination intersection before strategy", () => {
	it("selects only an explicitly pinned account", async () => {
		const ctx = makeContext([a, c, o]);
		const m = meta({ pin: { accountId: c.id, providers: null } });
		expect((await selectAccountsForRequest(m, ctx)).map((x) => x.id)).toEqual([
			c.id,
		]);
	});
	it("passes only provider-allowed accounts into the strategy", async () => {
		const ctx = makeContext([a, c, o]);
		const select = mock((accounts: (typeof a)[]) => accounts);
		ctx.strategy.select = select;
		const m = meta({
			pin: { accountId: null, providers: ["codex", "openrouter"] },
		});
		expect((await selectAccountsForRequest(m, ctx)).map((x) => x.id)).toEqual([
			c.id,
			o.id,
		]);
		expect(select.mock.calls[0][0].map((x) => x.id)).toEqual([c.id, o.id]);
	});
	for (const header of [
		"x-clankermux-account-id",
		"x-better-ccflare-account-id",
	]) {
		it(`narrows a provider pin with ${header}`, async () => {
			const ctx = makeContext([a, c, o]);
			const m = meta({
				pin: { accountId: null, providers: ["codex", "openrouter"] },
				headers: new Headers({ [header]: o.id }),
			});
			expect((await selectAccountsForRequest(m, ctx)).map((x) => x.id)).toEqual(
				[o.id],
			);
		});
		it(`rejects ${header} outside the allowed providers`, async () => {
			const ctx = makeContext([a, c, o]);
			const m = meta({
				pin: { accountId: null, providers: ["codex"] },
				headers: new Headers({ [header]: a.id }),
			});
			await expect(selectAccountsForRequest(m, ctx)).rejects.toThrow(
				"No permitted destination",
			);
		});
	}
	it("reports capacity unavailability for a paused pinned account", async () => {
		const ctx = makeContext([{ ...c, paused: true }, o]);
		const m = meta({ pin: { accountId: c.id, providers: null } });
		expect(await selectAccountsForRequest(m, ctx)).toEqual([]);
		expect(m.pinFailure?.code).toBe("pinned_account_unavailable");
	});
	it("reports capacity unavailability for a cooled provider pool", async () => {
		const ctx = makeContext([
			{ ...c, rate_limited_until: Date.now() + 60000 },
			a,
		]);
		const m = meta({ pin: { accountId: null, providers: ["codex"] } });
		expect(await selectAccountsForRequest(m, ctx)).toEqual([]);
		expect(m.pinFailure?.code).toBe("pinned_no_available_account");
	});
	it("rejects a missing pinned account without widening", async () => {
		await expect(
			selectAccountsForRequest(
				meta({ pin: { accountId: "missing", providers: null } }),
				makeContext([a, c, o]),
			),
		).rejects.toThrow("No permitted destination");
	});
	it("rejects ambiguous account and provider pins", async () => {
		await expect(
			selectAccountsForRequest(
				meta({ pin: { accountId: c.id, providers: ["codex"] } }),
				makeContext([a, c, o]),
			),
		).rejects.toThrow("Invalid API key destinations");
	});
	it("applies the Responses official-Anthropic exclusion to pinned traffic", async () => {
		await expect(
			selectAccountsForRequest(
				meta({
					pin: { accountId: a.id, providers: null },
					excludeOfficialAnthropic: true,
				}),
				makeContext([a, c]),
			),
		).rejects.toThrow("No permitted destination");
	});
	it("filters a strategy's stale account reference out of its result", async () => {
		const ctx = makeContext([a, c]);
		ctx.strategy.select = () => [a, c];
		expect(
			await selectAccountsForRequest(
				meta({ pin: { accountId: null, providers: ["codex"] } }),
				ctx,
			),
		).toEqual([c]);
	});
});
