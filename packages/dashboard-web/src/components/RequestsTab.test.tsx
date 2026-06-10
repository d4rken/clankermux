import { describe, expect, it } from "bun:test";
import { costBadgeProps } from "./RequestsTab";

describe("costBadgeProps", () => {
	it("renders neutral for plan-covered requests", () => {
		expect(costBadgeProps("plan")).toEqual({
			className: "text-xs",
			title: "Covered by plan",
		});
	});

	it("renders orange for overage (real per-token money)", () => {
		expect(costBadgeProps("overage")).toEqual({
			className: "text-xs border-orange-500 text-orange-500",
			title: "Pay-per-token",
		});
	});

	it("renders orange for api billing (pay-as-you-go keys)", () => {
		expect(costBadgeProps("api")).toEqual({
			className: "text-xs border-orange-500 text-orange-500",
			title: "Pay-per-token",
		});
	});

	it("renders neutral without a title when billing is unknown", () => {
		expect(costBadgeProps(null)).toEqual({
			className: "text-xs",
			title: undefined,
		});
		expect(costBadgeProps(undefined)).toEqual({
			className: "text-xs",
			title: undefined,
		});
		expect(costBadgeProps("something-else")).toEqual({
			className: "text-xs",
			title: undefined,
		});
	});
});
