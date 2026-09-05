import type { ModelFamily } from "./model-mappings";
import type { ScopedFamilyLimit } from "./scoped-limits";

/**
 * What one account's reading says about one model family's scoped weekly
 * window.
 *
 * The empirical basis for `"unopened"`: Anthropic omits a family's
 * `weekly_scoped` entry entirely until the account's first request against that
 * family in the current weekly window, and the entry reappears at 0–2% on that
 * first use (measured across 5 Max-20x orgs over 12 days, 2026-09-05). An
 * account whose payload names no window for a family its own servable class is
 * currently reporting has therefore not used the family this week.
 *
 * The state asserts NO percentage. It is evidence of absence — a payload was
 * read and named nothing — and must never be rendered as a 0% reading, a
 * forecast, or an invented reset. `"unreadable"` is the opposite claim (absence
 * of evidence) and the two must not be collapsed.
 */
export type ScopedFamilyEvidence =
	| "reports"
	| "unopened"
	| "unreadable"
	| "not-eligible";

export interface ScopedFamilyEvidenceInput {
	/** Usable scoped readings from ONE resolution; null = no scoped evidence at all. */
	readings: readonly ScopedFamilyLimit[] | null;
	/**
	 * Families with ANY `weekly_scoped` entry in that resolution's payload
	 * (usable or not); null when the resolution carried no payload (snapshot
	 * restore).
	 */
	presentFamilies: ReadonlySet<ModelFamily> | null;
	family: ModelFamily;
	/** Account-wide weekly reset from the SAME resolution, or null when unknown. */
	accountWideWeeklyResetMs: number | null;
	/** The account's servable class id (`servableClassFor(provider).classId`). */
	classId: string;
	/** Classes in which some UNPAUSED account currently reports `family`. */
	reportingClasses: ReadonlySet<string>;
	now: number;
}

/**
 * Classify one account's evidence for one family, from one resolution.
 *
 * Shared by the server's workload-headroom scan and the dashboard so both
 * surfaces label the same accounts unopened. Pass readings, presence and the
 * account-wide reset from a SINGLE resolution: mixing a live payload's scoped
 * list with a snapshot's account-wide reset would decide a week's worth of
 * absence from two different instants.
 */
export function classifyScopedFamilyEvidence(
	input: ScopedFamilyEvidenceInput,
): ScopedFamilyEvidence {
	const {
		readings,
		presentFamilies,
		family,
		accountWideWeeklyResetMs,
		classId,
		reportingClasses,
		now,
	} = input;

	if (readings?.some((limit) => limit.family === family)) return "reports";

	// A Codex account has no Fable window to be missing. Production hands every
	// non-Anthropic account an empty reading list, so without this gate each of
	// them would be labelled unopened for every Claude family.
	if (!reportingClasses.has(classId)) return "not-eligible";

	// No scoped evidence at all while a class sibling reports the family: a
	// snapshot-restored account carries account-wide windows only, and it may
	// well still be able to serve. Unchanged behaviour.
	if (readings === null) return "unreadable";

	// The payload NAMES the family but the entry is unusable (null percent,
	// unparseable reset, or a scoped reset already past while the account-wide
	// one is not). Evidence exists and cannot be read; it is never "unopened",
	// which would state the family untouched on the strength of a parse failure.
	if (presentFamilies?.has(family)) return "unreadable";

	// Read, named no window for the family, and the week that window would
	// belong to has not rolled over.
	if (accountWideWeeklyResetMs !== null && accountWideWeeklyResetMs > now) {
		return "unopened";
	}

	// The boundary tick right after a weekly reset: every scoped entry is stale
	// and gone, which is not evidence the family was never used. It stays
	// excluded exactly as it was before this state existed.
	return "not-eligible";
}
