import { describe, expect, it } from "bun:test";
import { cn } from "./utils";

/**
 * `cn()` is configured with the five custom `--spacing-*` names so that
 * tailwind-merge treats `p-row` as a padding utility rather than an unknown
 * class. Without that configuration a primitive's `pt-0` survives a call
 * site's `p-group` and the padding silently collapses to zero.
 *
 * These assertions are the only thing standing between a future
 * tailwind-merge bump and the silent return of that defect.
 */
describe("cn — custom spacing scale conflict resolution", () => {
	it("lets a numeric reset cancel named-scale padding", () => {
		expect(cn("px-row py-item p-0")).toBe("p-0");
	});

	it("collapses a repeated named padding and drops the cancelled reset", () => {
		expect(cn("p-group pt-0 p-group")).toBe("p-group");
	});

	it("lets a named side padding override a numeric one", () => {
		expect(cn("p-4 pt-0 pt-section")).toBe("p-4 pt-section");
	});

	// The composition that actually ships: `CardContent` carries `p-4 pt-0` and a
	// call site passes `p-group`. The two-argument form is the point — it takes a
	// different path through clsx than one pre-joined string, and it is how every
	// primitive merges its base classes with an incoming `className`.
	it("lets a call site's named padding replace a primitive's numeric pair", () => {
		expect(cn("p-4 pt-0", "p-group")).toBe("p-group");
	});
});
