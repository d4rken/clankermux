import type { WeeklyWorkload } from "@clankermux/core";
import type { WorkloadAvailability } from "../../services/public-workload-availability";
import { streamHelpers, truncateUtf8 } from "./dto";

const { instant } = streamHelpers;
export const PUBLIC_WORKLOADS_SCHEMA = "clankermux.public.workloads.v1";
export interface PublicWorkloadDto {
	id: string;
	label: string;
	parentWorkloadId: string | null;
	availability: {
		computedAt: string;
		context: "fresh_unpinned_nominal";
		availableAccounts: number;
		constrainedAccounts: number;
		unknownAccounts: number;
		nextRecoveryAt: string | null;
	};
	weekly: {
		computedAt: string;
		evidenceObservedAt: string | null;
		period: {
			startsAt: string;
			endsAt: string;
			endReason: "next_weekly_reset";
		} | null;
		outcome:
			| "exhausted"
			| "exhausts_before_end"
			| "lasts_until_end"
			| "unknown"
			| "no_accounts"
			| "not_applicable"
			| "other";
		reason:
			| "no_accounts"
			| "not_applicable"
			| "no_deadline"
			| "missing_evidence"
			| "limited_evidence"
			| "reset_elapsed"
			| "other"
			| null;
		quality: "supported" | "limited" | "unavailable" | "other";
		coverage: {
			eligibleAccounts: number;
			modeledAccounts: number;
			idleAccounts: number;
			learningAccounts: number;
			unavailableAccounts: number;
		};
		accountRisk: {
			spentAccounts: number;
			atRiskAccounts: number;
			withinBudgetAccounts: number;
			unknownAccounts: number;
		};
		exhaustsAt: string | null;
		pace: {
			state:
				| "estimate"
				| "increase_limit"
				| "reduction_limit"
				| "unavailable"
				| "other";
			changePct: number | null;
			qualification: "estimate" | "conservative_bound";
			reason:
				| "partial_coverage"
				| "weak_evidence"
				| "unsupported_credits"
				| "no_deadline"
				| "not_projected"
				| "search_unavailable"
				| "not_applicable"
				| "other"
				| null;
		};
	};
}
export interface PublicWorkloadsDto {
	schema: typeof PUBLIC_WORKLOADS_SCHEMA;
	generatedAt: string;
	workloads: PublicWorkloadDto[];
}
export function toPublicWorkloadsDto(
	availability: readonly WorkloadAvailability[],
	weekly: readonly WeeklyWorkload[],
	computedAtMs: number,
	now: number,
): PublicWorkloadsDto {
	const ids = new Set([
		...availability.map((a) => a.id),
		...weekly.map((w) => `${w.row.dimensionKind}:${w.row.dimensionId}`),
	]);
	return {
		schema: PUBLIC_WORKLOADS_SCHEMA,
		generatedAt: new Date(now).toISOString(),
		workloads: [...ids].sort().map((id) => {
			const a = availability.find((a) => a.id === id);
			const w = weekly.find(
				(w) => `${w.row.dimensionKind}:${w.row.dimensionId}` === id,
			);
			const n = w?.row.nextReset;
			const c = w?.coverage;
			const r = w?.risk;
			const expired = n !== null && n !== undefined && n.resetsAtMs <= now;
			const kind = n?.outcome.kind;
			return {
				id,
				label: truncateUtf8(a?.label ?? w?.row.label ?? id),
				parentWorkloadId: a?.parentId ?? w?.parentId ?? null,
				availability: {
					computedAt: new Date(a?.computedAtMs ?? now).toISOString(),
					context: "fresh_unpinned_nominal",
					availableAccounts: a?.availableAccounts ?? 0,
					constrainedAccounts: a?.constrainedAccounts ?? 0,
					unknownAccounts: a?.unknownAccounts ?? c?.eligibleAccounts ?? 0,
					nextRecoveryAt: instant(a?.nextRecoveryAtMs),
				},
				weekly: {
					computedAt: new Date(computedAtMs).toISOString(),
					evidenceObservedAt: instant(w?.observedAtMs),
					period: n
						? {
								startsAt: new Date(computedAtMs).toISOString(),
								endsAt: new Date(n.resetsAtMs).toISOString(),
								endReason: "next_weekly_reset",
							}
						: null,
					outcome: expired
						? "unknown"
						: !w
							? "no_accounts"
							: !w.applicable
								? "not_applicable"
								: kind === "runway"
									? "exhausts_before_end"
									: kind === "out-now"
										? "exhausted"
										: kind === "beyond-horizon"
											? "lasts_until_end"
											: "unknown",
					reason: expired
						? "reset_elapsed"
						: !w
							? "no_accounts"
							: !w.applicable
								? "not_applicable"
								: !n
									? "no_deadline"
									: kind === "unknown" || kind === "no-accounts"
										? "missing_evidence"
										: n.projectionBasis !== "measured"
											? "limited_evidence"
											: null,
					quality:
						expired ||
						!n ||
						!w?.applicable ||
						kind === "unknown" ||
						kind === "no-accounts"
							? "unavailable"
							: n.projectionBasis === "measured"
								? "supported"
								: "limited",
					coverage: {
						eligibleAccounts: c?.eligibleAccounts ?? 0,
						modeledAccounts: c?.modeledAccounts ?? 0,
						idleAccounts: c?.idleAccounts ?? 0,
						learningAccounts: c?.learningAccounts ?? 0,
						unavailableAccounts: c?.unavailableAccounts ?? 0,
					},
					accountRisk: {
						spentAccounts: r?.spentAccounts ?? 0,
						atRiskAccounts: r?.atRiskAccounts ?? 0,
						withinBudgetAccounts: r?.withinBudgetAccounts ?? 0,
						unknownAccounts: r?.unknownAccounts ?? 0,
					},
					exhaustsAt:
						!expired && n?.outcome.kind === "runway"
							? instant(n.outcome.exhaustsAtMs)
							: null,
					pace: {
						state: expired ? "unavailable" : (w?.pace.state ?? "unavailable"),
						changePct: expired ? null : (w?.pace.changePct ?? null),
						qualification:
							w?.row.dimensionKind === "family"
								? "conservative_bound"
								: "estimate",
						reason: expired
							? "no_deadline"
							: (w?.paceReason ?? (w ? null : "not_projected")),
					},
				},
			};
		}),
	};
}
