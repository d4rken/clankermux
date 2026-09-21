/**
 * Accepted swaps, as the dashboard endpoint sees them.
 *
 * Separate from `model-substitutions-direct.test.ts` because the claim under
 * test is different: that file pins what counts as a substitution at all, this
 * one pins what an operator's acceptance does to a substitution that already
 * counts. Accepted is not absent — the pair stays in the history and only loses
 * its claim on the operator's attention.
 */
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

const LUNA_UPGRADE: Raw = {
	pairs: [
		{
			accountId: "a",
			provider: "codex",
			outgoingModel: "gpt-5.6-luna",
			reportedModel: "gpt-6-luna",
			substituted: 30,
			firstAtMs: NOW - 10 * MINUTE,
			lastAtMs: NOW - MINUTE,
		},
	],
	comparable: [
		{ accountId: "a", outgoingModel: "gpt-5.6-luna", comparable: 30 },
	],
	series: [],
};

const ACCEPT_LUNA = [{ sent: "gpt-5.6-luna", served: "gpt-6-luna" }];

describe("computeModelSubstitutions — accepted swaps", () => {
	it("keeps an accepted pair in the history and flags it", () => {
		const result = computeModelSubstitutions(
			LUNA_UPGRADE,
			[account("a", "Codex-teddy")],
			NOW,
			ACCEPT_LUNA,
		);

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]?.accepted).toBe(true);
		expect(result.pairs[0]?.substituted).toBe(30);
	});

	it("does not call an account degraded for a swap that was accepted", () => {
		const result = computeModelSubstitutions(
			LUNA_UPGRADE,
			[account("a", "Codex-teddy")],
			NOW,
			ACCEPT_LUNA,
		);

		expect(result.degraded).toEqual([]);
	});

	it("degrades the same account with no exception configured", () => {
		const result = computeModelSubstitutions(
			LUNA_UPGRADE,
			[account("a", "Codex-teddy")],
			NOW,
		);

		expect(result.pairs[0]?.accepted).toBe(false);
		expect(result.degraded).toHaveLength(1);
		expect(result.degraded[0]?.accountName).toBe("Codex-teddy");
	});

	// Accepting one swap must not read as "substitution is fine on this
	// account": a different served model is a different decision.
	it("still degrades on a pair the exception does not name", () => {
		const result = computeModelSubstitutions(
			{
				pairs: [
					...LUNA_UPGRADE.pairs,
					{
						accountId: "a",
						provider: "codex",
						outgoingModel: "gpt-6-astra",
						reportedModel: "gpt-5.6-luna",
						substituted: 90,
						firstAtMs: NOW - 10 * MINUTE,
						lastAtMs: NOW - MINUTE,
					},
				],
				comparable: [
					...LUNA_UPGRADE.comparable,
					{ accountId: "a", outgoingModel: "gpt-6-astra", comparable: 100 },
				],
				series: [],
			},
			[account("a", "Codex-teddy")],
			NOW,
			ACCEPT_LUNA,
		);

		expect(result.pairs).toHaveLength(2);
		expect(result.degraded).toHaveLength(1);
		// Only the unaccepted pair reaches the chip's tooltip.
		expect(result.degraded[0]?.pairs).toHaveLength(1);
		expect(result.degraded[0]?.pairs[0]?.outgoingModel).toBe("gpt-6-astra");
	});
});

describe("the endpoint carries the exception list as a query param", () => {
	// A param rather than a config read: this handler also runs inside the
	// analytics worker, which has no Config to read.
	it("applies repeated exception params", async () => {
		const handler = createModelSubstitutionsHandlerFromSources({
			getModelSubstitutions: async () => LUNA_UPGRADE,
			getAllAccounts: async () => [account("a", "Codex-teddy")],
			now: () => NOW,
		});

		const params = new URLSearchParams({ range: "24h" });
		params.append("exception", "gpt-5.6-luna>gpt-6-luna");
		const body = (await (await handler(params)).json()) as {
			pairs: Array<{ accepted: boolean }>;
			degraded: unknown[];
		};

		expect(body.pairs[0]?.accepted).toBe(true);
		expect(body.degraded).toEqual([]);
	});

	it("degrades when the param is absent", async () => {
		const handler = createModelSubstitutionsHandlerFromSources({
			getModelSubstitutions: async () => LUNA_UPGRADE,
			getAllAccounts: async () => [account("a", "Codex-teddy")],
			now: () => NOW,
		});

		const body = (await (
			await handler(new URLSearchParams({ range: "24h" }))
		).json()) as {
			pairs: Array<{ accepted: boolean }>;
			degraded: unknown[];
		};

		expect(body.pairs[0]?.accepted).toBe(false);
		expect(body.degraded).toHaveLength(1);
	});
});
