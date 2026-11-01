import {
	computeWindowStartMs,
	DAILY_ELIGIBLE_PROVIDERS,
	extractDaily,
	extractFiveHour,
	extractSevenDay,
	FIVE_HOUR_ELIGIBLE_PROVIDERS,
	fiveHourKnownAbsent,
	getModelFamily,
	isUnstartedWindow,
	normalizeResetMs,
	type PoolWindow,
	providerDisplayName,
	SEVEN_DAY_ELIGIBLE_PROVIDERS,
	usageWindowObservedAtMs,
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
	/**
	 * The account's SHORT window — a rolling 5 hours for most providers, a
	 * calendar day for Devin. Which one it is comes from the row's
	 * {@link QuotaSummaryRow.shortWindow}, so a reader never has to infer the
	 * length from the number.
	 */
	shortWindowRemainingPct: number | null;
	/**
	 * The row's short window, or null when this account's payload states it has
	 * none (a verified Ultra or Codex account on a 5-hour provider). Its
	 * `shortWindowRemainingPct` is then null for that reason, not for want of a
	 * reading.
	 */
	shortWindow: PoolWindow | null;
	resetMs: number | null;
	shortWindowResetMs: number | null;
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
	/**
	 * Which window `shortWindowRemainingPct` measures, or null when the provider
	 * runs none or no account in the row has it. Never inferred from the
	 * provider at the render site: a caller that guessed would label Devin's
	 * 24-hour allowance "5h".
	 */
	shortWindow: PoolWindow | null;
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
		// Which short window a provider runs is a property of the PROVIDER, and a
		// provider that runs none must not be given a row that implies otherwise.
		// Whether one account HAS it is the account's own payload's to say.
		const providerShortWindow: PoolWindow | null =
			FIVE_HOUR_ELIGIBLE_PROVIDERS.has(provider)
				? "five_hour"
				: DAILY_ELIGIBLE_PROVIDERS.has(provider)
					? "daily"
					: null;
		const shortWindowOf = (a: AccountResponse): PoolWindow | null =>
			providerShortWindow === "five_hour" && fiveHourKnownAbsent(a.usageData)
				? null
				: providerShortWindow;
		const shortWindow = members.some((a) => shortWindowOf(a) !== null)
			? providerShortWindow
			: null;
		for (const [model, label] of scopes) {
			const metered =
				model !== null || SEVEN_DAY_ELIGIBLE_PROVIDERS.has(provider);
			const rows = members.map((a): QuotaAccount => {
				const week = a.usageData ? extractSevenDay(a.usageData) : null;
				const ownShortWindow = shortWindowOf(a);
				const short =
					!a.usageData || ownShortWindow === null
						? null
						: ownShortWindow === "daily"
							? extractDaily(a.usageData)
							: extractFiveHour(a.usageData);
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
				exhausted(
					short,
					ownShortWindow === "daily"
						? "Daily limit reached"
						: "5h limit reached",
				);
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
						(short?.resetMs != null && short.resetMs <= now))
				)
					gates.push({ status: "Awaiting quota reading", reset: null });
				const recoveryMs =
					gates.length && gates.every((g) => g.reset !== null)
						? Math.max(...gates.map((g) => g.reset as number))
						: null;
				const displayReset = (
					value: Reading | null,
					window: PoolWindow | "seven_day_scoped",
				) => {
					if (value?.resetMs == null || value.resetMs <= now) return null;
					if (
						window !== "seven_day_scoped" &&
						isUnstartedWindow({
							utilizationPct: value.pct ?? Number.NaN,
							windowStartMs: computeWindowStartMs(value.resetMs, window),
							observedAtMs: usageWindowObservedAtMs(a, window),
							windowKind: window,
						})
					)
						return null;
					return value.resetMs;
				};
				return {
					id: a.id,
					name: a.name,
					remainingPct: pct,
					shortWindowRemainingPct: remaining(short, now),
					shortWindow: ownShortWindow,
					resetMs: displayReset(
						reading,
						model === null ? "seven_day" : "seven_day_scoped",
					),
					shortWindowResetMs:
						ownShortWindow === null
							? null
							: displayReset(short, ownShortWindow),
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
				shortWindow,
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
