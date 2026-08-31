import { describe, expect, it } from "bun:test";
import { CHART_TOOLTIP_STYLE } from "../../constants";
import { getTooltipStyles } from "./chart-utils";

describe("getTooltipStyles", () => {
	it("keeps the token surface when a caller overrides only part of it", () => {
		const styles = getTooltipStyles({ maxWidth: 240 }) as Record<
			string,
			unknown
		>;

		expect(styles.backgroundColor).toBe(CHART_TOOLTIP_STYLE.backgroundColor);
		expect(styles.border).toBe(CHART_TOOLTIP_STYLE.border);
		expect(styles.borderRadius).toBe(CHART_TOOLTIP_STYLE.borderRadius);
		expect(styles.boxShadow).toBe(CHART_TOOLTIP_STYLE.boxShadow);
		expect(styles.maxWidth).toBe(240);
	});

	it("returns exactly the token surface when called with no argument", () => {
		expect(getTooltipStyles()).toEqual({ ...CHART_TOOLTIP_STYLE });
	});
});
