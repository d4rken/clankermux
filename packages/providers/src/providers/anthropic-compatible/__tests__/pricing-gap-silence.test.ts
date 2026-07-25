import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __pricingTestHooks, getPricingGaps } from "@clankermux/core";
import { AnthropicCompatibleProvider } from "../factory";

/**
 * The provider-level usage extractors call `estimateCostUSD` for their own
 * `costUsd` field, and on the normal proxy path they price the SAME response the
 * proxy's usage collector prices a moment later. They must therefore stay silent
 * about pricing gaps:
 *
 *  - if they reported too, every miss would be counted twice and `occurrences`
 *    would not be a request count; and
 *  - they have no account attribution, so an Ollama request would raise a
 *    banner here before the collector's suppressed call ever ran.
 *
 * Reporting is opt-in and only the collector opts in — this test guards that.
 */

// Keep pricing deterministic and offline: the bundled table is the sole source
// of truth, and the disk cache lives somewhere disposable.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
	throw new Error("pricing test network disabled");
};
const originalTmpdir = process.env.TMPDIR;
const pricingTmpdir = mkdtempSync(join(tmpdir(), "cmux-provider-pricing-"));
process.env.TMPDIR = pricingTmpdir;

afterAll(() => {
	globalThis.fetch = originalFetch;
	if (originalTmpdir === undefined) {
		delete process.env.TMPDIR;
	} else {
		process.env.TMPDIR = originalTmpdir;
	}
	rmSync(pricingTmpdir, { recursive: true, force: true });
	__pricingTestHooks.reset();
});

// `bun test` shares one process across files, so an earlier suite can leave
// pricing state behind — start every case from a clean registry.
beforeEach(() => {
	__pricingTestHooks.reset();
});

afterEach(() => {
	__pricingTestHooks.reset();
});

const UNKNOWN_MODEL = "provider-level-unpriced-model";

describe("provider-level usage extraction does not report pricing gaps", () => {
	it("stays silent for a non-streaming response with an unpriced model", async () => {
		const provider = new AnthropicCompatibleProvider();
		const response = new Response(
			JSON.stringify({
				model: UNKNOWN_MODEL,
				usage: { input_tokens: 100, output_tokens: 10 },
			}),
			{ headers: { "content-type": "application/json" } },
		);

		const usage = await provider.extractUsageInfo(response);

		// The cost still collapses to 0 — that part is unchanged…
		expect(usage?.costUsd).toBe(0);
		// …but nothing is surfaced from here.
		expect(getPricingGaps()).toEqual([]);
	});

	it("stays silent for a streaming response with an unpriced model", async () => {
		const provider = new AnthropicCompatibleProvider();
		const body =
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					model: UNKNOWN_MODEL,
					usage: { input_tokens: 100, output_tokens: 0 },
				},
			})}\n\n` +
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				usage: { output_tokens: 10 },
			})}\n\n`;
		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});

		const usage = await provider.extractUsageInfo(response);

		expect(usage?.costUsd).toBe(0);
		expect(getPricingGaps()).toEqual([]);
	});
});
