/**
 * The substitution history table.
 *
 * The claim worth pinning is the accepted marker. An accepted swap keeps
 * happening by design, so without something on the row saying so, a pair
 * sitting at 100% while the mode reads Enforce looks like the failover is
 * broken.
 */
import { describe, expect, it } from "bun:test";
import type {
	ModelSubstitutionPair,
	ModelSubstitutionsResponse,
} from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSubstitutionCard } from "./ModelSubstitutionCard";

function pair(
	over: Partial<ModelSubstitutionPair> = {},
): ModelSubstitutionPair {
	return {
		accountId: "acc-1",
		accountName: "Codex-teddy",
		provider: "codex",
		outgoingModel: "gpt-5.6-luna",
		reportedModel: "gpt-6-luna",
		accepted: false,
		substituted: 30,
		comparable: 30,
		firstAtMs: Date.UTC(2026, 8, 21, 10),
		lastAtMs: Date.UTC(2026, 8, 21, 11),
		...over,
	};
}

function render(pairs: ModelSubstitutionPair[]): string {
	const data: ModelSubstitutionsResponse = {
		pairs,
		degraded: [],
		series: [],
		generatedAtMs: Date.UTC(2026, 8, 21, 12),
	};
	return renderToStaticMarkup(<ModelSubstitutionCard data={data} />);
}

describe("ModelSubstitutionCard", () => {
	it("lists the models on both sides of a swap", () => {
		const html = render([pair()]);
		expect(html).toContain("gpt-5.6-luna");
		expect(html).toContain("gpt-6-luna");
		expect(html).toContain("Codex-teddy");
	});

	it("marks a swap the operator accepted", () => {
		expect(render([pair({ accepted: true })])).toContain("accepted");
	});

	it("does not mark one that is still enforced", () => {
		expect(render([pair({ accepted: false })])).not.toContain(">accepted<");
	});

	// An accepted pair is not hidden: acceptance changes what the proxy does
	// with the swap, not whether the operator gets to see it.
	it("still shows the counts for an accepted swap", () => {
		const html = render([pair({ accepted: true })]);
		expect(html).toContain("30");
		expect(html).toContain("100%");
	});
});
