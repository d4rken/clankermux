/**
 * Cost per model, when the cost rows arrive split by how the model was reached.
 *
 * `costByModel` now carries one row for ordinary usage and one per model that a
 * model was substituted FOR, while the performance table has a single row per
 * model. Picking the first matching cost row would charge a model with whichever
 * subset happened to sort first, which on live data is the substituted one: for
 * gpt-5.6-luna that is 2,740 of 3,774 requests on one day, so the visible cost
 * per 1K tokens would come out of the wrong denominator.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelAnalytics } from "./ModelAnalytics";

const PERFORMANCE = [
	{
		model: "gpt-5.6-luna",
		avgResponseTime: 1000,
		p95ResponseTime: 2000,
		errorRate: 0,
		medianTokensPerSecond: 50,
		p95TokensPerSecond: 80,
		speedSampleCount: 10,
	},
];

function render(
	costByModel: Array<{
		model: string;
		costUsd: number;
		requests: number;
		totalTokens?: number;
		substitutedFrom?: string;
	}>,
): string {
	return renderToStaticMarkup(
		<ModelAnalytics modelPerformance={PERFORMANCE} costByModel={costByModel} />,
	);
}

describe("ModelAnalytics cost join", () => {
	it("sums the split rows for one model", () => {
		// $3 over 3,000,000 tokens. Either row alone yields a different cost per
		// 1K, so the rendered figure identifies which rows were counted.
		const split = render([
			{
				model: "gpt-5.6-luna",
				costUsd: 1,
				requests: 100,
				totalTokens: 1_000_000,
			},
			{
				model: "gpt-5.6-luna",
				costUsd: 2,
				requests: 200,
				totalTokens: 2_000_000,
				substitutedFrom: "gpt-6-astra",
			},
		]);
		const whole = render([
			{
				model: "gpt-5.6-luna",
				costUsd: 3,
				requests: 300,
				totalTokens: 3_000_000,
			},
		]);

		expect(split).toBe(whole);
	});

	// A model whose traffic was ENTIRELY substituted has no ordinary row at all,
	// so a join that only looked at unsubstituted rows would leave it costless.
	it("still reads a model that has only a substituted row", () => {
		const html = render([
			{
				model: "gpt-5.6-luna",
				costUsd: 2,
				requests: 200,
				totalTokens: 2_000_000,
				substitutedFrom: "gpt-6-astra",
			},
		]);

		// $2 over 2M tokens is $0.0010 per 1K. A missed row renders an em dash.
		expect(html).toContain("$0.0010");
	});
});
