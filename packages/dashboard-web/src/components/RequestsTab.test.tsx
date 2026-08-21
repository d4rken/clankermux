import { describe, expect, it } from "bun:test";
import {
	costBadgeProps,
	decodeNameSelectValue,
	nameSelectValue,
} from "./RequestsTab";

describe("costBadgeProps", () => {
	it("renders neutral for plan-covered requests", () => {
		expect(costBadgeProps("plan")).toEqual({
			className: "text-xs",
			title: "Covered by plan",
		});
	});

	it("renders the warning tone for overage (real per-token money)", () => {
		expect(costBadgeProps("overage")).toEqual({
			className: "text-xs border-warning text-warning-strong",
			title: "Pay-per-token",
		});
	});

	it("renders the warning tone for api billing (pay-as-you-go keys)", () => {
		expect(costBadgeProps("api")).toEqual({
			className: "text-xs border-warning text-warning-strong",
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

describe("nameSelectValue / decodeNameSelectValue", () => {
	it("round-trips an account literally named 'all' as a name", () => {
		// The account select used to pass raw names through, so picking an
		// account called "all" decoded back to the any-account sentinel and
		// showed every request with no filter chip.
		const value = nameSelectValue({ name: "all", none: false });

		expect(value).not.toBe("all");
		expect(decodeNameSelectValue(value)).toEqual({ name: "all", none: false });
	});

	it("round-trips a name colliding with the empty-bucket sentinel", () => {
		const value = nameSelectValue({ name: "none", none: false });

		expect(decodeNameSelectValue(value)).toEqual({ name: "none", none: false });
	});

	it("keeps both sentinels distinct from every name", () => {
		expect(nameSelectValue({ name: null, none: false })).toBe("all");
		expect(nameSelectValue({ name: null, none: true })).toBe("none");
		expect(decodeNameSelectValue("all")).toEqual({ name: null, none: false });
		expect(decodeNameSelectValue("none")).toEqual({ name: null, none: true });
	});
});
