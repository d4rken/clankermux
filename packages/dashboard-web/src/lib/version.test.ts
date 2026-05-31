import { describe, expect, it } from "bun:test";
import { commitRelationshipLabel } from "./version";

describe("commitRelationshipLabel", () => {
	it("reports up to date when neither ahead nor behind", () => {
		expect(commitRelationshipLabel(0, 0)).toBe("Up to date with main");
		expect(commitRelationshipLabel(null, null)).toBe("Up to date with main");
	});

	it("prefers the behind count when behind main", () => {
		expect(commitRelationshipLabel(0, 3)).toBe("3 commits behind main");
		expect(commitRelationshipLabel(2, 1)).toBe("1 commit behind main");
	});

	it("reports ahead when only ahead of main", () => {
		expect(commitRelationshipLabel(2, 0)).toBe("2 commits ahead of main");
		expect(commitRelationshipLabel(1, null)).toBe("1 commit ahead of main");
	});
});
