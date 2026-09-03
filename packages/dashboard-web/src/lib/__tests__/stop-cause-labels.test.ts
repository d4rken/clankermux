import { describe, expect, it } from "bun:test";
import { STOP_CAUSES } from "@clankermux/types";
import { STOP_CAUSE_COLORS, STOP_CAUSE_LABELS } from "../stop-cause-labels";

describe("stop cause presentation tables", () => {
	it("covers every cause", () => {
		for (const cause of STOP_CAUSES) {
			expect(STOP_CAUSE_LABELS[cause]).toBeTruthy();
			expect(STOP_CAUSE_COLORS[cause]).toBeTruthy();
		}
		expect(Object.keys(STOP_CAUSE_LABELS).sort()).toEqual(
			[...STOP_CAUSES].sort(),
		);
		expect(Object.keys(STOP_CAUSE_COLORS).sort()).toEqual(
			[...STOP_CAUSES].sort(),
		);
	});

	it("gives every named cause its own hue", () => {
		// A stacked bar is only readable if two segments cannot wear the same
		// colour. `other` is exempt: it is the unclassified bucket rather than a
		// cause, and it sits outside the palette on purpose.
		const named = STOP_CAUSES.filter((cause) => cause !== "other");
		const colors = named.map((cause) => STOP_CAUSE_COLORS[cause]);
		expect(new Set(colors).size).toBe(named.length);
		expect(colors).not.toContain(STOP_CAUSE_COLORS.other);
	});

	it("says what happened rather than repeating the wire value", () => {
		expect(STOP_CAUSE_LABELS.model_not_served).toBe(
			"Model not served by any account",
		);
		expect(STOP_CAUSE_LABELS.family_weekly_exhausted).toBe(
			"Model weekly limit",
		);
	});
});
