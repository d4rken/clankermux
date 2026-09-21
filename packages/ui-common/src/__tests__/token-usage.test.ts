import { describe, expect, it } from "bun:test";
import { processTokenUsage } from "../components/TokenUsageDisplay";

describe("processTokenUsage", () => {
	it("reports no data only when the counts are absent", () => {
		expect(processTokenUsage(undefined).hasData).toBe(false);
		expect(processTokenUsage({}).hasData).toBe(false);
		expect(processTokenUsage({ totalTokens: 0 }).hasData).toBe(false);
	});

	it("renders a request that consumed nothing as zeros", () => {
		// The row states its usage exactly; "No token usage data available"
		// would be a different, and false, claim about it.
		const usage = processTokenUsage({
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		});

		expect(usage.hasData).toBe(true);
		expect(usage.sections.inputTokens?.value).toBe("0");
		expect(usage.sections.outputTokens?.value).toBe("0");
		expect(usage.sections.totalTokens?.value).toBe("0");
	});

	it("keeps a zero cache class off the display", () => {
		// A tile per unused cache class on every ordinary request is noise; the
		// counts are still published on the client API, which is where a
		// consumer that needs the zero reads it.
		const usage = processTokenUsage({
			inputTokens: 40,
			outputTokens: 10,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});

		expect(usage.sections.cacheReadTokens).toBeUndefined();
		expect(usage.sections.cacheCreationTokens).toBeUndefined();
	});

	it("still renders counts that did arrive", () => {
		const usage = processTokenUsage({
			inputTokens: 1_200,
			outputTokens: 340,
			cacheReadInputTokens: 800,
		});

		expect(usage.sections.inputTokens?.value).toBe("1,200");
		expect(usage.sections.cacheReadTokens?.value).toBe("800");
	});
});
