import { describe, expect, it } from "bun:test";
import { ageLabel } from "../age-label";

describe("ageLabel", () => {
	const now = 10_000_000;

	it("drops to the largest whole unit that fits", () => {
		expect(ageLabel(now - 5_000, now)).toBe("5s ago");
		expect(ageLabel(now - 120_000, now)).toBe("2m ago");
		expect(ageLabel(now - 7_200_000, now)).toBe("2h ago");
		expect(ageLabel(now - 3 * 86_400_000, now)).toBe("3d ago");
	});

	it("truncates rather than rounding, so a label never claims more age than elapsed", () => {
		expect(ageLabel(now - 119_000, now)).toBe("1m ago");
	});

	it("clamps a timestamp ahead of the clock to zero", () => {
		// A server-supplied instant can lead the browser's clock by the skew
		// between them; "-3s ago" would read as a bug in the data.
		expect(ageLabel(now + 3_000, now)).toBe("0s ago");
	});
});
