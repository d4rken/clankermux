import { describe, expect, it } from "bun:test";
import type { DegradedAccount } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { DegradedChip } from "./DegradedChip";

function degraded(over: Partial<DegradedAccount> = {}): DegradedAccount {
	return {
		accountId: "acc-1",
		accountName: "Codex-me",
		provider: "codex",
		pairs: [
			{
				accountId: "acc-1",
				accountName: "Codex-me",
				provider: "codex",
				outgoingModel: "gpt-6-astra",
				reportedModel: "gpt-5.6-luna",
				substituted: 87,
				comparable: 100,
				firstAtMs: Date.UTC(2026, 8, 17),
				lastAtMs: Date.UTC(2026, 8, 21),
			},
		],
		...over,
	};
}

describe("DegradedChip", () => {
	// Absence is the clearing rule: the server decides what counts as degraded
	// now, so an account that stopped simply stops being passed one.
	it("renders nothing without an entry", () => {
		expect(renderToStaticMarkup(<DegradedChip degraded={undefined} />)).toBe(
			"",
		);
	});

	it("renders nothing for an entry with no pairs", () => {
		expect(
			renderToStaticMarkup(<DegradedChip degraded={degraded({ pairs: [] })} />),
		).toBe("");
	});

	it("shows one word, with the evidence in the tooltip", () => {
		const html = renderToStaticMarkup(<DegradedChip degraded={degraded()} />);
		expect(html).toContain("Degraded");
		// The models belong in the title, not in the chip body beside plan and
		// priority chips.
		expect(html).toContain("Sent gpt-6-astra, served gpt-5.6-luna");
		expect(html).toContain("87 of 100");
		expect(html).toContain("87%");
	});

	it("lists every pair in the tooltip", () => {
		const entry = degraded();
		const [first] = entry.pairs;
		if (!first) throw new Error("fixture must supply a pair");
		const html = renderToStaticMarkup(
			<DegradedChip
				degraded={{
					...entry,
					pairs: [
						first,
						{
							...first,
							outgoingModel: "gpt-5.6-luna",
							reportedModel: "gpt-6-luna",
						},
					],
				}}
			/>,
		);
		expect(html).toContain("Sent gpt-5.6-luna, served gpt-6-luna");
	});
});
