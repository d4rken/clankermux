/**
 * Which pairs reach the Overview banner.
 *
 * The endpoint returns accepted swaps alongside enforced ones on purpose, so
 * this filter is the only thing keeping an accepted swap from bannering. At the
 * rate substitution runs on one account here, getting that wrong means a banner
 * on every page load, in every browser, for a decision already made.
 */
import { describe, expect, it } from "bun:test";
import type { ModelSubstitutionPair } from "@clankermux/types";
import { unacknowledgedSubstitutions } from "./ModelSubstitutionBanner";

function pair(
	over: Partial<ModelSubstitutionPair> = {},
): ModelSubstitutionPair {
	return {
		accountId: "acc-1",
		accountName: "Codex-me",
		provider: "codex",
		outgoingModel: "gpt-6-astra",
		reportedModel: "gpt-5.6-luna",
		accepted: false,
		substituted: 87,
		comparable: 100,
		firstAtMs: Date.UTC(2026, 8, 17),
		lastAtMs: Date.UTC(2026, 8, 21),
		...over,
	};
}

const never = () => false;
const always = () => true;

describe("unacknowledgedSubstitutions", () => {
	it("surfaces an unseen, unaccepted pair", () => {
		expect(unacknowledgedSubstitutions([pair()], never)).toHaveLength(1);
	});

	it("drops an accepted pair even when it has never been acknowledged", () => {
		expect(
			unacknowledgedSubstitutions([pair({ accepted: true })], never),
		).toEqual([]);
	});

	it("drops an acknowledged pair", () => {
		expect(unacknowledgedSubstitutions([pair()], always)).toEqual([]);
	});

	it("keeps the unaccepted pair when only one of two is accepted", () => {
		const result = unacknowledgedSubstitutions(
			[
				pair({ accepted: true, reportedModel: "gpt-6-luna" }),
				pair({ accepted: false }),
			],
			never,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.reportedModel).toBe("gpt-5.6-luna");
	});
});
