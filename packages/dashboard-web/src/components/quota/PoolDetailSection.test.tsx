import { describe, expect, it } from "bun:test";
import type { PoolUsageResult } from "@clankermux/core";
import { renderToStaticMarkup } from "react-dom/server";
import { PoolDetailSection } from "./PoolDetailSection";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/**
 * Two accounts called the same thing, in different rows of the breakdown, plus
 * two fallback rows sharing a third name.
 *
 * Account names are user-set and need not be unique, so this shape is ordinary
 * rather than pathological: one `claude` per browser profile is how the pool
 * gets populated in the first place.
 */
function sharedNamePool(): PoolUsageResult {
	return {
		contributing: [
			{
				accountId: "id-reporting",
				name: "claude",
				pct: 40,
				resetMs: NOW + DAY,
			},
		],
		exhausted: [],
		excluded: [
			{
				accountId: "id-paused",
				name: "claude",
				reason: "paused",
				resetMs: null,
			},
		],
		fallback: [
			{ accountId: "id-fallback-a", name: "local", provider: "ollama" },
			{ accountId: "id-fallback-b", name: "local", provider: "litellm" },
		],
		earliestResetMs: NOW + DAY,
		earliestResetAccountName: "claude",
		atRisk: [],
		familyWeekly: [],
		classes: [],
		bindingClass: null,
	};
}

/** Renders the section with `console.error` captured rather than printed. */
function renderCapturingErrors(result: PoolUsageResult): {
	html: string;
	errors: string[];
} {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		return {
			html: renderToStaticMarkup(
				<PoolDetailSection result={result} window="seven_day" />,
			),
			errors,
		};
	} finally {
		console.error = original;
	}
}

function occurrences(html: string, needle: string): number {
	return html.split(needle).length - 1;
}

describe("PoolDetailSection with duplicate account names", () => {
	it("renders every row when two accounts share a name", () => {
		const { html, errors } = renderCapturingErrors(sharedNamePool());

		// Both `claude` accounts are present, in the sections their state puts
		// them in: keying these rows by name made the second one a duplicate key,
		// and the same name in two rows is the normal case, not a corrupt one.
		expect(occurrences(html, 'title="claude"')).toBe(2);
		expect(html).toContain("Reporting (1)");
		expect(html).toContain("Unknown (1)");
		expect(html).toContain("Paused");

		// Both fallback rows too, distinguishable only by their provider.
		expect(html).toContain("Outside this window (2)");
		expect(html).toContain("(ollama)");
		expect(html).toContain("(litellm)");

		// React never had to complain about the keys. Static rendering does not
		// reconcile, so this asserts the contract rather than reproducing the
		// client-side symptom.
		expect(errors.filter((e) => e.includes('unique "key" prop'))).toEqual([]);
	});
});
