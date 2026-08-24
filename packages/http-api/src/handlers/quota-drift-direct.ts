import { QuotaDriftResultRepository } from "@clankermux/database";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@clankermux/http-common";
import { Logger } from "@clankermux/logger";
import type {
	QuotaDriftCohort,
	QuotaDriftModel,
	QuotaDriftPoint,
	QuotaDriftResponse,
	QuotaDriftVerdict,
	QuotaDriftWindowResult,
} from "@clankermux/types";
import type { APIContext } from "../types";

const log = new Logger("QuotaDriftHandler");

/**
 * Direct (in-process) `/api/analytics/quota-drift` implementation.
 *
 * A single-row read: the analysis itself is precomputed by the scheduler (see
 * apps/server/src/quota-drift-scheduler.ts) and stored as one JSON blob, so
 * this handler only picks the newest row. Nothing here re-derives the payload;
 * the wire contract is written by the pass that produced it.
 *
 * ## Why the payload is normalized rather than handed over verbatim
 *
 * The blob is stored JSON and is NOT schema-validated on the way out, and the
 * precompute only refreshes every 30 minutes. So for up to one refresh interval
 * after any deploy, the newest stored payload is one that a PREVIOUS version of
 * the code wrote, missing whatever fields that version did not have. Declaring
 * those fields required on the wire type would not protect this path — it would
 * only make TypeScript assert something false about it.
 *
 * They are therefore optional on the type and defaulted here, once, so every
 * reader downstream sees one shape: absent numbers become null (never 0, which
 * would read as a measurement) and absent lists become empty.
 */
export interface QuotaDriftSources {
	getLatest(): Promise<{ computedAt: number; payload: string } | null>;
}

/**
 * The answer when no pass has completed yet.
 *
 * EXPLICIT rather than an empty `ready` payload: a panel handed
 * `{cohorts: []}` renders a blank chart, which reads as "measured, and nothing
 * is drifting" — the opposite of "we have not measured yet". The scheduler runs
 * shortly after boot, so this is what the first minute of a fresh deployment
 * (or a database whose results were pruned) legitimately looks like.
 */
export const COMPUTING_RESPONSE: QuotaDriftResponse = {
	status: "computing",
	computedAt: null,
	computeMs: null,
	cohorts: [],
};

export function createQuotaDriftHandler(context: APIContext) {
	const repo = new QuotaDriftResultRepository(context.dbOps.getAdapter());
	return createQuotaDriftHandlerFromSources({
		getLatest: () => repo.getLatest(),
	});
}

export function createQuotaDriftHandlerFromSources(sources: QuotaDriftSources) {
	return async (_params: URLSearchParams): Promise<Response> => {
		try {
			const row = await sources.getLatest();
			if (!row) return jsonResponse(COMPUTING_RESPONSE);

			let payload: QuotaDriftResponse;
			try {
				payload = JSON.parse(row.payload) as QuotaDriftResponse;
			} catch (error) {
				// A corrupt blob is not a server fault the user can act on, and it
				// self-heals on the next pass. Report it as "computing" rather than
				// 500-ing a dashboard panel over a cache row.
				log.warn(`Discarding unreadable quota-drift payload: ${error}`);
				return jsonResponse(COMPUTING_RESPONSE);
			}

			// The stored blob owns `computedAt`, but the row's key is the
			// authoritative one — they are written together, and trusting the key
			// keeps a hand-inserted or half-migrated blob from claiming a time.
			return jsonResponse({
				...normalizeQuotaDriftPayload(payload),
				status: "ready",
				computedAt: row.computedAt,
			} satisfies QuotaDriftResponse);
		} catch (error) {
			log.error("Failed to read quota-drift result:", error);
			return errorResponse(
				InternalServerError("Failed to fetch quota drift data"),
			);
		}
	};
}

/**
 * The verdict a stored payload's value means today.
 *
 * The old name was renamed to `no-change-detected` — same semantics, a name
 * that states what the test established rather than what a reader might infer.
 * The cached blob can be up to one refresh interval old, so a payload written
 * before the rename is a shape this handler must still parse; narrowing from
 * `unknown` (rather than from the public union, which no longer contains the old
 * name) is what lets the legacy value be mapped instead of passed through as an
 * unknown verdict.
 *
 * Anything unrecognised becomes `insufficient-evidence`: the one verdict that
 * claims nothing. A payload we cannot read must never assert a negative result.
 */
function normalizeVerdict(verdict: unknown): QuotaDriftVerdict {
	if (verdict === "changed") return "changed";
	if (verdict === "no-change-detected" || verdict === "stable") {
		return "no-change-detected";
	}
	return "insufficient-evidence";
}

/** `[]` for anything that is not an array — a cached blob is untrusted input. */
function asArray<T>(value: readonly T[] | undefined | null): T[] {
	return Array.isArray(value) ? [...value] : [];
}

/**
 * Fill in every field a payload written by an older version of the precompute
 * would be missing.
 *
 * Exported so a test can drive it with a pre-change payload directly: this is
 * the only thing standing between a 30-minute-old cache row and a panel that
 * reads `window.flatSince` on an object that has never heard of it.
 */
export function normalizeQuotaDriftPayload(
	payload: QuotaDriftResponse,
): QuotaDriftResponse {
	return {
		...payload,
		// Null, never an empty audit: `{claims: []}` renders as "the series is
		// empty", which is a measurement claim, and the opposite of "this payload
		// predates the audit".
		claimAudit: payload.claimAudit ?? null,
		cohorts: asArray(payload.cohorts).map(
			(cohort): QuotaDriftCohort => ({
				...cohort,
				windows: asArray(cohort.windows).map(
					(window): QuotaDriftWindowResult => ({
						...window,
						// Null, never 0: a concrete timestamp or percentage would claim a
						// measurement the payload does not contain.
						lastMovementMs: window.lastMovementMs ?? null,
						lastObservedMs: window.lastObservedMs ?? null,
						// Null, not the flat value: a payload that predates this field
						// records no percentage for its newest reading, and substituting
						// one from another field would quote a reading that was never
						// taken.
						lastObservedValuePct: window.lastObservedValuePct ?? null,
						flatValuePct: window.flatValuePct ?? null,
						flatSince: window.flatSince ?? null,
						// Null, not "all-accounts". A payload written before the scope
						// existed cannot vouch for who its flat claim covered, and
						// defaulting to the unqualified reading would restore exactly the
						// overclaim the field was added to prevent.
						flatScope: window.flatScope ?? null,
						notReportedSince: window.notReportedSince ?? null,
						// Null for the same reason, and the scope matters more here: an
						// unqualified absence claim reads as "no account carries this
						// window any more", which a payload that predates the field
						// cannot vouch for.
						notReportedScope: window.notReportedScope ?? null,
						models: asArray(window.models).map(
							(model): QuotaDriftModel => ({
								...model,
								// Narrowed from the STORED shape, which may still carry the
								// pre-rename verdict; the public union no longer does.
								verdict: normalizeVerdict(
									(model as { verdict?: unknown }).verdict,
								),
								points: asArray(model.points).map(
									(point): QuotaDriftPoint => ({
										...point,
										unidentifiedReasons: asArray(point.unidentifiedReasons),
									}),
								),
								latest: model.latest
									? {
											...model.latest,
											unidentifiedReasons: asArray(
												model.latest.unidentifiedReasons,
											),
											// Null, never 0: a payload that predates the support
											// counts vouches for no runs and no accounts, and a 0
											// would read as "counted, and nothing supports it".
											nRuns: model.latest.nRuns ?? null,
											nAccounts: model.latest.nAccounts ?? null,
										}
									: null,
							}),
						),
					}),
				),
			}),
		),
	};
}
