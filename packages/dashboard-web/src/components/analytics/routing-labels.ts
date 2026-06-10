// Shared human-readable labels for routing-strategy decision keys, so a
// newly-added decision only needs a label in one place.

const DECISION_LABELS: Record<string, string> = {
	affinity_hit: "Affinity hit",
	affinity_hold: "Affinity hold",
	affinity_miss: "Affinity miss",
	affinity_reassigned: "Affinity reassigned",
	auto_fallback: "Auto fallback",
	combo: "Routing Chain",
	force_account_global: "Forced (global)",
	forced_account: "Forced account",
	global_session: "Global session",
	least_used: "Least used",
	priority_utilization: "Priority + usage",
	untracked: "Untracked",
};

export function labelDecision(decision: string): string {
	return DECISION_LABELS[decision] ?? decision.replaceAll("_", " ");
}
