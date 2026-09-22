/**
 * Verified served-model pairs, as the substitutions surfaces see them.
 *
 * The proxy already knows that `grok-4.6` answered as `grok-4.6-build` on a
 * SuperGrok subscription account is ONE model under two names, and lets the
 * response through. Reporting has to agree: a request that succeeded must not
 * be drawn as a swap on the substitutions page or in its history chart, or the
 * dashboard accuses an account of degrading every time it answers correctly.
 *
 * The pair is keyed by provider, so the SAME two ids on any other provider
 * stay a substitution.
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@clankermux/types";
import { computeModelSubstitutions } from "../model-substitutions-direct";

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const MINUTE = 60_000;

function account(id: string, name: string): Account {
	return { id, name, provider: "grok-subscription" } as Account;
}

type Raw = Parameters<typeof computeModelSubstitutions>[0];

function pairRow(
	over: Partial<Raw["pairs"][number]> = {},
): Raw["pairs"][number] {
	return {
		accountId: "a",
		provider: "grok-subscription",
		outgoingModel: "grok-4.6",
		reportedModel: "grok-4.6-build",
		substituted: 40,
		firstAtMs: NOW - 10 * MINUTE,
		lastAtMs: NOW - MINUTE,
		...over,
	};
}

function raw(over: Partial<Raw> = {}): Raw {
	return { pairs: [], comparable: [], series: [], ...over };
}

describe("computeModelSubstitutions — verified served-model pairs", () => {
	it("does not report the renamed model the provider is known to answer with", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [pairRow()],
				comparable: [
					{ accountId: "a", outgoingModel: "grok-4.6", comparable: 40 },
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.pairs).toEqual([]);
		expect(result.degraded).toEqual([]);
	});

	// The pair is a fact about ONE provider's naming, not about the two ids.
	it("still reports the same two ids on a different provider", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [pairRow({ provider: "openrouter" })],
				comparable: [
					{ accountId: "a", outgoingModel: "grok-4.6", comparable: 40 },
				],
			}),
			[account("a", "OpenRouter")],
			NOW,
		);

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]?.reportedModel).toBe("grok-4.6-build");
		expect(result.degraded).toHaveLength(1);
	});

	// `grok-4.7` and `grok-4.7-build-fast` are two separately published models,
	// so this provider swapping one for the other is a real swap.
	it("still reports a genuine substitution on the same provider", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [
					pairRow({
						outgoingModel: "grok-4.7",
						reportedModel: "grok-4.7-build-fast",
					}),
				],
				comparable: [
					{ accountId: "a", outgoingModel: "grok-4.7", comparable: 40 },
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]?.outgoingModel).toBe("grok-4.7");
		expect(result.degraded).toHaveLength(1);
	});

	// The reverse direction is the same model under the same two names: the
	// proxy may send either spelling once a catalogue publishes the renamed id.
	it("does not report the pair in the direction it was not observed in", () => {
		const result = computeModelSubstitutions(
			raw({
				pairs: [
					pairRow({
						outgoingModel: "grok-4.6-build",
						reportedModel: "grok-4.6",
					}),
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.pairs).toEqual([]);
	});
});

describe("the substitution history chart counts the same rule", () => {
	it("leaves the accepted rename out of the bucket's substituted count", () => {
		const result = computeModelSubstitutions(
			raw({
				series: [
					{
						bucketMs: NOW - MINUTE,
						comparable: 10,
						candidates: [
							{
								provider: "grok-subscription",
								outgoingModel: "grok-4.6",
								reportedModel: "grok-4.6-build",
								count: 7,
							},
						],
					},
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.series).toHaveLength(1);
		expect(result.series[0]?.substituted).toBe(0);
		// The denominator is every comparable attempt, renamed or not.
		expect(result.series[0]?.comparable).toBe(10);
	});

	it("counts a genuine swap in the same bucket", () => {
		const result = computeModelSubstitutions(
			raw({
				series: [
					{
						bucketMs: NOW - MINUTE,
						comparable: 10,
						candidates: [
							{
								provider: "grok-subscription",
								outgoingModel: "grok-4.6",
								reportedModel: "grok-4.6-build",
								count: 7,
							},
							{
								provider: "grok-subscription",
								outgoingModel: "grok-4.7",
								reportedModel: "grok-4.7-build-fast",
								count: 2,
							},
						],
					},
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.series[0]?.substituted).toBe(2);
	});

	// Same re-checking rule as the pair list: a candidate the comparison has
	// since learned to normalise stops counting, whenever it was recorded.
	it("drops a candidate the normalisation rejects for any provider", () => {
		const result = computeModelSubstitutions(
			raw({
				series: [
					{
						bucketMs: NOW - MINUTE,
						comparable: 4,
						candidates: [
							{
								provider: "anthropic",
								outgoingModel: "claude-haiku-4-5",
								reportedModel: "claude-haiku-4-5-20251001",
								count: 4,
							},
						],
					},
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.series[0]?.substituted).toBe(0);
	});

	// `routing_attempts.provider` is nullable, so a row that predates it must
	// fall back to the provider-blind comparison rather than being dropped.
	it("counts a candidate with no recorded provider", () => {
		const result = computeModelSubstitutions(
			raw({
				series: [
					{
						bucketMs: NOW - MINUTE,
						comparable: 3,
						candidates: [
							{
								provider: null,
								outgoingModel: "grok-4.6",
								reportedModel: "grok-4.6-build",
								count: 3,
							},
						],
					},
				],
			}),
			[account("a", "SuperGrok")],
			NOW,
		);

		expect(result.series[0]?.substituted).toBe(3);
	});
});
