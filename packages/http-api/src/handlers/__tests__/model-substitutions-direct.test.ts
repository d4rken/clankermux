import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import {
	computeModelSubstitutions,
	createModelSubstitutionsHandlerFromSources,
} from "../model-substitutions-direct";

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const MINUTE = 60_000;

function account(id: string, name: string): Account {
	return { id, name, provider: "codex" } as Account;
}

type Raw = Parameters<typeof computeModelSubstitutions>[0];

function raw(over: Partial<Raw> = {}): Raw {
	return { pairs: [], comparable: [], series: [], ...over };
}

describe("computeModelSubstitutions", () => {
	it("pairs each substitution with an honest denominator", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [
					{
						accountId: "a",
						provider: "codex",
						outgoingModel: "gpt-6-astra",
						reportedModel: "gpt-5.6-luna",
						substituted: 87,
						firstAtMs: NOW - 60 * MINUTE,
						lastAtMs: NOW - MINUTE,
					},
				],
				comparable: [
					{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 100 },
				],
			}),
			[account("a", "Codex-me")],
			NOW,
		);

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]?.accountName).toBe("Codex-me");
		expect(result.pairs[0]?.substituted).toBe(87);
		// 100, not 87: attempts that were served correctly belong in the
		// denominator or the share is always 100%.
		expect(result.pairs[0]?.comparable).toBe(100);
	});

	// The reason this re-checks the comparison instead of trusting the rows.
	it("drops rows a later normalisation has learned are not substitutions", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [
					{
						accountId: "a",
						provider: "anthropic",
						outgoingModel: "claude-haiku-4-5",
						reportedModel: "claude-haiku-4-5-20251001",
						substituted: 500,
						firstAtMs: NOW - MINUTE,
						lastAtMs: NOW,
					},
					{
						accountId: "a",
						provider: "codex",
						outgoingModel: "codex-auto-review",
						reportedModel: "gpt-5.6-luna",
						substituted: 671,
						firstAtMs: NOW - MINUTE,
						lastAtMs: NOW,
					},
				],
			}),
			[account("a", "Codex-me")],
			NOW,
		);

		expect(result.pairs).toEqual([]);
		expect(result.degraded).toEqual([]);
	});
});

describe("computeModelSubstitutions — what counts as degraded NOW", () => {
	function pairRow(over: Partial<Raw["pairs"][number]> = {}) {
		return {
			accountId: "a",
			provider: "codex",
			outgoingModel: "gpt-6-astra",
			reportedModel: "gpt-5.6-luna",
			substituted: 50,
			firstAtMs: NOW - 10 * MINUTE,
			lastAtMs: NOW - MINUTE,
			...over,
		};
	}

	it("reports an account substituting recently and often", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [pairRow()],
				comparable: [
					{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 100 },
				],
			}),
			[account("a", "Codex-me")],
			NOW,
		);

		expect(result.degraded).toHaveLength(1);
		expect(result.degraded[0]?.accountName).toBe("Codex-me");
	});

	it("clears once the substitutions age out of the active window", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [pairRow({ lastAtMs: NOW - 120 * MINUTE })],
				comparable: [
					{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 100 },
				],
			}),
			[account("a", "Codex-me")],
			NOW,
		);

		// Still history, no longer a present-tense claim about the account.
		expect(result.pairs).toHaveLength(1);
		expect(result.degraded).toEqual([]);
	});

	it("ignores a single stray substitution in a healthy stream", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [pairRow({ substituted: 1 })],
				comparable: [
					{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 500 },
				],
			}),
			[account("a", "Codex-me")],
			NOW,
		);

		expect(result.degraded).toEqual([]);
	});

	it("ignores a sample too small to mean anything", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [pairRow({ substituted: 2 })],
				comparable: [
					{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 2 },
				],
			}),
			[account("a", "Codex-me")],
			NOW,
		);

		expect(result.degraded).toEqual([]);
	});
});

describe("createModelSubstitutionsHandlerFromSources", () => {
	it("answers over the requested range and names the account", async () => {
		const seen: Array<{ sinceMs: number; bucketMs: number }> = [];
		const handler = createModelSubstitutionsHandlerFromSources({
			getModelSubstitutions: async (opts) => {
				seen.push(opts);
				return raw({
					pairs: [
						{
							accountId: "a",
							provider: "codex",
							outgoingModel: "gpt-6-astra",
							reportedModel: "gpt-5.6-luna",
							substituted: 9,
							firstAtMs: NOW - MINUTE,
							lastAtMs: NOW,
						},
					],
					comparable: [
						{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 10 },
					],
					series: [{ bucketMs: NOW, substituted: 9, comparable: 10 }],
				});
			},
			getAllAccounts: async () => [account("a", "Codex-me")],
			now: () => NOW,
		});

		const response = await handler(new URLSearchParams({ range: "24h" }));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.pairs[0]?.accountName).toBe("Codex-me");
		expect(body.series).toHaveLength(1);
		expect(body.generatedAtMs).toBe(NOW);
		expect(seen[0]?.sinceMs).toBe(NOW - 24 * 60 * MINUTE);
	});

	it("reads the whole history for range=all", async () => {
		const seen: Array<{ sinceMs: number; bucketMs: number }> = [];
		const handler = createModelSubstitutionsHandlerFromSources({
			getModelSubstitutions: async (opts) => {
				seen.push(opts);
				return raw();
			},
			getAllAccounts: async () => [],
			now: () => NOW,
		});

		await handler(new URLSearchParams({ range: "all" }));
		expect(seen[0]?.sinceMs).toBe(0);
	});
});
