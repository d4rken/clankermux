import { describe, expect, it } from "bun:test";
import type { ModelFamily } from "../model-mappings";
import {
	classifyScopedFamilyEvidence,
	type ScopedFamilyEvidenceInput,
} from "../scoped-family-evidence";
import type { ScopedFamilyLimit } from "../scoped-limits";

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function reading(
	family: ModelFamily,
	percent = 40,
	resetsAtMs = NOW + 3 * DAY,
): ScopedFamilyLimit {
	return {
		family,
		percent,
		resetsAtMs,
		isActive: true,
		displayName: family,
	};
}

function input(
	over: Partial<ScopedFamilyEvidenceInput> = {},
): ScopedFamilyEvidenceInput {
	return {
		readings: [],
		presentFamilies: new Set<ModelFamily>(),
		idleFamilies: new Set<ModelFamily>(),
		family: "fable",
		accountWideWeeklyResetMs: NOW + 3 * DAY,
		classId: "anthropic",
		reportingClasses: new Set(["anthropic"]),
		now: NOW,
		...over,
	};
}

describe("classifyScopedFamilyEvidence", () => {
	it("reports a family the readings carry", () => {
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: [reading("fable")],
					presentFamilies: new Set<ModelFamily>(["fable"]),
				}),
			),
		).toBe("reports");
	});

	it("calls an empty reading list with a future weekly reset unopened", () => {
		// The account was read, the payload named no window for this family, and
		// the week it would belong to has not rolled over. A sibling in the class
		// reports it, so the family exists — this account has simply not used it.
		expect(classifyScopedFamilyEvidence(input())).toBe("unopened");
	});

	it("calls a reading list carrying only another family unopened", () => {
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: [reading("opus")],
					presentFamilies: new Set<ModelFamily>(["opus"]),
				}),
			),
		).toBe("unopened");
	});

	it("calls a present but unusable entry unreadable, never unopened", () => {
		// A null percent or an unparseable reset drops the entry from the usable
		// readings while the payload still names the family. Evidence exists and
		// cannot be read; claiming the family was untouched would invent a fact.
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: [],
					presentFamilies: new Set<ModelFamily>(["fable"]),
				}),
			),
		).toBe("unreadable");
	});

	it("excludes the boundary tick where the account-wide reset is exactly now", () => {
		expect(
			classifyScopedFamilyEvidence(input({ accountWideWeeklyResetMs: NOW })),
		).toBe("not-eligible");
	});

	it("excludes a reading list with no account-wide weekly reset at all", () => {
		expect(
			classifyScopedFamilyEvidence(input({ accountWideWeeklyResetMs: null })),
		).toBe("not-eligible");
	});

	it("calls the idle form unopened while the account-wide week is still running", () => {
		// Anthropic's OTHER shape for an unused window: the entry is present at 0%
		// with no reset instead of absent. Same fact as an omitted entry, so it
		// must reach the same state.
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: [],
					presentFamilies: new Set<ModelFamily>(["fable"]),
					idleFamilies: new Set<ModelFamily>(["fable"]),
				}),
			),
		).toBe("unopened");
	});

	it("calls the idle form unreadable once the account-wide week has rolled over", () => {
		// After the rollover the entry says nothing about the week now running,
		// and it EXISTS, so the account stays in the row as unreadable rather than
		// being dropped.
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: [],
					presentFamilies: new Set<ModelFamily>(["fable"]),
					idleFamilies: new Set<ModelFamily>(["fable"]),
					accountWideWeeklyResetMs: NOW - DAY,
				}),
			),
		).toBe("unreadable");
	});

	it("calls the idle form unreadable when the account-wide reset is unknown", () => {
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: [],
					presentFamilies: new Set<ModelFamily>(["fable"]),
					idleFamilies: new Set<ModelFamily>(["fable"]),
					accountWideWeeklyResetMs: null,
				}),
			),
		).toBe("unreadable");
	});

	it("keeps an account with no scoped evidence unreadable when its class reports", () => {
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: null,
					presentFamilies: null,
					idleFamilies: null,
				}),
			),
		).toBe("unreadable");
	});

	it("drops an account with no scoped evidence when its class does not report", () => {
		expect(
			classifyScopedFamilyEvidence(
				input({
					readings: null,
					presentFamilies: null,
					idleFamilies: null,
					classId: "codex",
					reportingClasses: new Set(["anthropic"]),
				}),
			),
		).toBe("not-eligible");
	});

	it("drops an account whose class does not report the family, readings or not", () => {
		// A Codex account has no Fable window to be missing. Production hands every
		// non-Anthropic account an empty reading list, so without the class gate
		// each of them would be labelled unopened for every Claude family.
		expect(
			classifyScopedFamilyEvidence(
				input({ classId: "codex", reportingClasses: new Set(["anthropic"]) }),
			),
		).toBe("not-eligible");
	});
});
