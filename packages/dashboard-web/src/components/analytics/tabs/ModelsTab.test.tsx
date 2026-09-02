import { describe, expect, it } from "bun:test";
import { ANALYTICS_SECTIONS } from "@clankermux/types";
import { MODELS_SECTIONS } from "./ModelsTab";

describe("MODELS_SECTIONS", () => {
	it("requests the refusal/fallback section the tab renders a panel for", () => {
		// Without this the server omits the field entirely, and the panel would
		// render nothing while looking exactly like "no refusals in range".
		expect(MODELS_SECTIONS).toContain("refusalFallbacks");
	});

	it("names only sections the server knows how to compute", () => {
		for (const section of MODELS_SECTIONS) {
			expect(ANALYTICS_SECTIONS).toContain(section);
		}
	});
});
