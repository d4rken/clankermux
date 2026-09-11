import {
	computeWindowStartMs,
	extractFiveHour,
	extractSevenDay,
	getModelFamily,
	isUnstartedWindow,
	normalizeResetMs,
	providerDisplayName,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
	usageObservedAtMs,
} from "@clankermux/core";
import {
	type AccountResponse,
	type AnthropicUsageData,
	NON_LIMITED_RATE_LIMIT_CAUSES,
	type UsageScopedHistoryResponse,
} from "@clankermux/types";

export interface QuotaAccount {
	id: string;
	name: string;
	remainingPct: number | null;
	fiveHourRemainingPct: number | null;
	resetMs: number | null;
	fiveHourResetMs: number | null;
	available: boolean;
	unknown: boolean;
	status: string;
	recoveryMs: number | null;
}
export interface QuotaSummaryRow {
	id: string;
	provider: string;
	model: string | null;
	label: string;
	accounts: QuotaAccount[];
	remainingPct: number | null;
	knownCount: number;
	availableCount: number;
	unknownCount: number;
	recoveryMs: number | null;
	metered: boolean;
}
interface Reading {
	pct: number | null;
	resetMs: number | null;
}
const remaining = (reading: Reading | null, now: number): number | null =>
	reading?.pct != null &&
	Number.isFinite(reading.pct) &&
	(reading.resetMs == null || reading.resetMs > now)
		? Math.max(0, Math.min(100, 100 - reading.pct))
		: null;

function scopedEntries(account: AccountResponse) {
	return (
		(account.usageData as AnthropicUsageData | null)?.limits ?? []
	).filter((e) => e.kind === "weekly_scoped" && e.scope?.model?.display_name);
}
function modelKey(label: string, id?: string | null): string {
	return getModelFamily(label) ?? id ?? label;
}

/** All configured accounts remain members. Quota and request availability are independent. */
export function buildQuotaSummary(
	accounts: AccountResponse[],
	now: number,
	history?: UsageScopedHistoryResponse,
): QuotaSummaryRow[] {
	const providers = [...new Set(accounts.map((a) => a.provider))].sort();
	const result: QuotaSummaryRow[] = [];
	for (const provider of providers) {
		const members = accounts
			.filter((a) => a.provider === provider)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		const models = new Map<string, string>();
		for (const a of members)
			for (const entry of scopedEntries(a)) {
				const label = entry.scope?.model?.display_name;
				if (label) models.set(modelKey(label, entry.scope?.model?.id), label);
			}
		// Historical membership retains a family when its live window disappears at reset.
		for (const family of history?.families ?? [])
			if (family.series.some((s) => members.some((a) => a.id === s.accountId)))
				models.set(
					family.family,
					models.get(family.family) ?? family.displayName,
				);
		const scopes: Array<[string | null, string]> = [
			[null, providerDisplayName(provider)],
			...[...models].sort((a, b) => a[0].localeCompare(b[0])),
		];
		for (const [model, label] of scopes) {
			const metered =
				model !== null || SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider);
			const rows = members.map((a): QuotaAccount => {
				const week = a.usageData ? extractSevenDay(a.usageData) : null;
				const five = a.usageData ? extractFiveHour(a.usageData) : null;
				let reading = week;
				if (model !== null) {
					const entries = scopedEntries(a).filter(
						(e) =>
							modelKey(
								e.scope?.model?.display_name ?? "",
								e.scope?.model?.id,
							) === model,
					);
					const valid = entries.map((e) => ({
						pct:
							typeof e.percent === "number" && Number.isFinite(e.percent)
								? e.percent
								: null,
						resetMs: normalizeResetMs(e.resets_at),
					}));
					reading =
						valid
							.filter(
								(e) =>
									e.pct !== null &&
									((e.resetMs !== null && e.resetMs > now) ||
										(e.pct === 0 && e.resetMs === null)),
							)
							.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? null;
					// Anthropic omits an untouched family's window. Missing data on other providers is unknown.
					if (
						!entries.length &&
						provider === "anthropic" &&
						week?.resetMs != null &&
						week.resetMs > now &&
						week.pct != null
					)
						reading = { pct: 0, resetMs: null };
				}
				const gates: Array<{ status: string; reset: number | null }> = [];
				if (a.paused) gates.push({ status: "Paused", reset: null });
				if (
					a.hasRefreshToken &&
					a.tokenExpiresAt &&
					Date.parse(a.tokenExpiresAt) < now
				)
					gates.push({ status: "Token expired", reset: null });
				const exhausted = (value: Reading | null, status: string) => {
					if (
						value?.pct != null &&
						value.pct >= 100 &&
						(value.resetMs === null || value.resetMs > now)
					)
						gates.push({ status, reset: value.resetMs });
				};
				exhausted(week, "Weekly limit reached");
				exhausted(five, "5h limit reached");
				if (model !== null) exhausted(reading, "Model limit reached");
				if (a.rateLimitedUntil && a.rateLimitedUntil > now)
					gates.push({ status: "Cooling down", reset: a.rateLimitedUntil });
				if (a.usageThrottledUntil && a.usageThrottledUntil > now)
					gates.push({ status: "Pacing hold", reset: a.usageThrottledUntil });
				for (const gate of a.providerOverload ?? [])
					if (gate.family === null || gate.family === model)
						gates.push({ status: "Provider overloaded", reset: null });
				if (
					a.rateLimitCause &&
					!NON_LIMITED_RATE_LIMIT_CAUSES.has(a.rateLimitCause) &&
					!(
						a.rateLimitCause === "usage_exhausted" &&
						gates.some((g) => g.status.endsWith("limit reached"))
					) &&
					!(
						a.rateLimitCause === "rate_limited" &&
						(a.rateLimitedUntil ?? 0) > now
					)
				)
					gates.push({
						status:
							a.rateLimitCause === "payment_required"
								? "Payment required"
								: a.rateLimitCause === "unknown"
									? "Availability unknown"
									: "Temporarily unavailable",
						reset:
							a.rateLimitCauseResetMs && a.rateLimitCauseResetMs > now
								? a.rateLimitCauseResetMs
								: null,
					});
				const pct = remaining(reading, now);
				if (
					!gates.length &&
					metered &&
					(pct === null ||
						(SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider) &&
							remaining(week, now) === null) ||
						(five?.resetMs != null && five.resetMs <= now))
				)
					gates.push({ status: "Awaiting quota reading", reset: null });
				const recoveryMs =
					gates.length && gates.every((g) => g.reset !== null)
						? Math.max(...gates.map((g) => g.reset as number))
						: null;
				const displayReset = (
					value: Reading | null,
					window: "five_hour" | "seven_day" | "seven_day_scoped",
				) => {
					if (value?.resetMs == null || value.resetMs <= now) return null;
					if (
						window !== "seven_day_scoped" &&
						isUnstartedWindow({
							utilizationPct: value.pct ?? Number.NaN,
							windowStartMs: computeWindowStartMs(value.resetMs, window),
							observedAtMs: usageObservedAtMs(a.usageAsOfIso),
						})
					)
						return null;
					return value.resetMs;
				};
				return {
					id: a.id,
					name: a.name,
					remainingPct: pct,
					fiveHourRemainingPct: remaining(five, now),
					resetMs: displayReset(
						reading,
						model === null ? "seven_day" : "seven_day_scoped",
					),
					fiveHourResetMs: displayReset(five, "five_hour"),
					available: !gates.length,
					unknown:
						gates.length > 0 &&
						gates.every(
							(g) =>
								g.status === "Awaiting quota reading" ||
								g.status === "Availability unknown",
						),
					status: gates.map((g) => g.status).join(" · ") || "Available",
					recoveryMs,
				};
			});
			const known = rows.filter((a) => a.remainingPct !== null);
			const recovery = rows.flatMap((a) =>
				a.recoveryMs === null ? [] : [a.recoveryMs],
			);
			result.push({
				id: `${provider}:${model ?? "all"}`,
				provider,
				model,
				label,
				accounts: rows,
				metered,
				remainingPct:
					known.length === rows.length && known.length > 0
						? known.reduce((sum, a) => sum + (a.remainingPct ?? 0), 0) /
							known.length
						: null,
				knownCount: known.length,
				availableCount: rows.filter((a) => a.available).length,
				unknownCount: rows.filter((a) => a.unknown).length,
				recoveryMs: recovery.length ? Math.min(...recovery) : null,
			});
		}
	}
	return result;
}
export function usageHref(
	row: Pick<QuotaSummaryRow, "provider" | "model">,
): string {
	const params = new URLSearchParams({ provider: row.provider });
	if (row.model) params.set("model", row.model);
	return `/usage?${params}`;
}
