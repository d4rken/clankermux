/**
 * Standing audit of the request-aligned claim series.
 *
 * Pure and DB-free by construction, like the quota-drift estimator beside it:
 * it consumes an iterable of already-shaped observation rows, so every claim it
 * makes can be checked against synthetic rows with known answers. The
 * precompute path (http-api) supplies the cursor; this module decides what may
 * be counted from it.
 */
export {
	auditClaimSeries,
	GIFT_DROP_THRESHOLD,
	GRID_TOLERANCE,
	MAX_TRACKED_LABELS,
	MAX_TRACKED_VALUES,
	RESET_JITTER_TOLERANCE_MS,
	TOP_VALUES_K,
} from "./audit";
export type {
	ClaimAuditRange,
	ClaimAuditReport,
	ClaimComposition,
	ClaimLabelCount,
	ClaimObservationInput,
	ClaimSeriesAudit,
	ClaimValueCount,
} from "./types";
