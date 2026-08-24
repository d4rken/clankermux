/**
 * Quota-drift estimator — how much of a usage window one model's traffic
 * actually consumes, and whether that number has moved.
 *
 * Pure and DB-free by construction: every export here consumes already-assembled
 * segments, so the whole module can be checked against synthetic data with known
 * ground truth. The precompute path (http-api) supplies the data; this module
 * decides what may be claimed from it.
 */
export {
	type ChangepointOptions,
	type ChangepointResult,
	detectChanges,
	MAX_DEPTH,
	MIN_RELATIVE_BOOTSTRAP_SD,
	MIN_RELATIVE_CHANGE,
	MIN_SIDE_DAYS,
	MIN_SIDE_SEGMENTS,
	NOMINAL_LEVEL,
} from "./changepoint";
export {
	ANTHROPIC_EQ_WEIGHTS,
	EQ_WEIGHTS,
	type EqTokenProvider,
	type EqTokenWeights,
	eqTokenProviderFor,
	eqTokens,
	MODEL_EQ_WEIGHT_OVERRIDES,
	OPENAI_EQ_WEIGHTS,
} from "./eq-tokens";
export {
	actualModelKeys,
	bootstrapCoefficients,
	buildFitInput,
	CI_COVERAGE,
	columnTolerances,
	DISPLAY_BOOTSTRAP_B,
	type ExposureSupport,
	exposureSupport,
	type FitOptions,
	fitOnce,
	fitRolling,
	fitWithIntervals,
	INFERENCE_BOOTSTRAP_B,
	MAX_RELATIVE_CI_WIDTH,
	MIN_MODEL_SHARE,
	MIN_RUNS_FOR_INTERVAL,
	MIN_SEGMENTS_FOR_FIT,
	MIN_TOLERANCE,
	mulberry32,
	percentile,
	ROLLING_STEP_MS,
	ROLLING_WINDOW_MS,
	type RollingOptions,
	seedFromParts,
	selectKeys,
	shareByKey,
	zeroTokenDeltaShare,
} from "./fit";
export { normalizeModelKey, OTHER_MODEL_KEY } from "./model-key";
export { choleskySolve, type NnlsResult, nnls, olsSolve } from "./nnls";
export {
	type BuildSegmentsOptions,
	bucketMsForWindow,
	buildSegments,
	MAX_SAMPLE_GAP_MS,
	RESET_MOVE_TOLERANCE_MS,
	type SampleRun,
	splitRuns,
	type WindowSample,
} from "./segments";
export type {
	CoefficientEstimate,
	DetectedChange,
	FitInput,
	FitResult,
	QuotaSegment,
	QuotaVerdict,
	QuotaWindowKind,
	SeriesPoint,
	TierProvenance,
	TokenCounts,
	UnidentifiedReason,
} from "./types";
