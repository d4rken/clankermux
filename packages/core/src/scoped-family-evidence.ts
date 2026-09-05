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
 * ABSENT and IDLE (0%, no reset) are the two observed forms of an unused
 * window: the same provider also lists the entry at `percent: 0` with no
 * `resets_at` (observed live 2026-09-05), because a window that has not opened
 * has no reset instant yet. Both forms mean the family was not touched, and
 * only the idle one carries an entry — so it must be read as unopened rather
 * than as a window whose reset failed to parse.
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
	/**
	 * Families whose entry in that resolution's payload is the IDLE form — 0%
	 * with no reset, the shape Anthropic emits for a window with no usage this
	 * week; null when the resolution carried no payload (snapshot restore).
	 *
	 * A subset of {@link presentFamilies}: the entry exists, it just states no
	 * measurement. Absent is not empty, for the same reason presence draws that
	 * distinction.
	 */
	idleFamilies: ReadonlySet<ModelFamily> | null;
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
 * surfaces label the same accounts unopened. Pass readings, presence, idleness
 * and the account-wide reset from a SINGLE resolution: mixing a live payload's
 * scoped list with a snapshot's account-wide reset would decide a week's worth
 * of absence from two different instants.
 *
 * `"unopened"` covers BOTH observed forms of an unused window — the entry
 * absent, and the entry present as the idle form (0%, no reset) — because they
 * state the same fact about the account.
 */
export function classifyScopedFamilyEvidence(
	input: ScopedFamilyEvidenceInput,
): ScopedFamilyEvidence {
	const {
		readings,
		presentFamilies,
		idleFamilies,
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

	// The IDLE form of an unused window: the entry is there at 0% with no reset,
	// which is the provider stating that this family's window has not opened —
	// the same fact as an omitted entry, so it must reach the same state. Gated
	// on the account-wide week still running, exactly like the absent form:
	// after a rollover the entry says nothing about the week now in force.
	if (
		idleFamilies?.has(family) &&
		accountWideWeeklyResetMs !== null &&
		accountWideWeeklyResetMs > now
	) {
		return "unopened";
	}

	// The payload NAMES the family but the entry is unusable (null percent,
	// unparseable reset, a non-zero percent with no reset, a scoped reset already
	// past while the account-wide one is not, or an idle entry whose account-wide
	// week has rolled over or is unknown). Evidence exists and cannot be read; it
	// is never "unopened", which would state the family untouched on the strength
	// of a parse failure. The account stays in the row rather than being dropped:
	// the entry exists, so this resolution has something to say about it.
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
