import type { ModelFamily } from "@clankermux/core";
import React, { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { TimeRange } from "../../constants";
import { useUsageHistory, useUsageScopedHistory } from "../../hooks/queries";
import { useQuotaSummary } from "../../hooks/useQuotaSummary";
import { dataAvailability } from "../../lib/data-availability";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import { QuotaAttention } from "../quota/QuotaAttention";
import { QuotaAccountTable, QuotaSummary } from "../quota/QuotaSummary";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { FocusedQuotaChart } from "./UsageSawtoothChart";

export const LimitsTab = React.memo(() => {
	const summary = useQuotaSummary();
	const [params, setParams] = useSearchParams();
	const providers = summary.rows.filter((row) => row.model === null);
	const provider =
		providers.find((row) => row.provider === params.get("provider"))
			?.provider ?? providers[0]?.provider;
	const models = summary.rows.filter((row) => row.provider === provider);
	const selected =
		models.find((row) => row.model === (params.get("model") || null)) ??
		models[0];
	const [range, setRange] = useState<TimeRange>("7d");
	const [window, setWindow] = useState<"seven_day" | "five_hour">("seven_day");
	const showForecast = params.get("forecast") === "1";
	const setShowForecast = (value: boolean) =>
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (value) next.set("forecast", "1");
				else next.delete("forecast");
				return next;
			},
			{ replace: true },
		);
	const [showAccounts, setShowAccounts] = useState(false);
	const history = useUsageHistory(range, !!selected && !selected.model);
	const scoped = useUsageScopedHistory(range, !!selected?.model);
	const query = selected?.model ? scoped : history;
	const availability = dataAvailability(query, query.isLoading);
	const accounts = useMemo(
		() => summary.accounts.filter((a) => a.provider === provider),
		[summary.accounts, provider],
	);
	const forecastWindow = useMemo(
		() =>
			selected?.model
				? { kind: "family" as const, family: selected.model as ModelFamily }
				: window,
		[selected?.model, window],
	);
	function select(provider: string, model: string | null) {
		setParams((prev) => {
			const next = new URLSearchParams(prev);
			next.set("provider", provider);
			if (model) next.set("model", model);
			else next.delete("model");
			return next;
		});
	}
	return (
		<div className="space-y-section">
			<QuotaSummary
				{...summary}
				selectedId={selected?.id}
				showBreakdown={false}
			/>
			<QuotaAttention rows={summary.rows} now={summary.now} />
			<Card id="forecast">
				<CardHeader>
					<CardTitle>Usage history</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="mb-group flex flex-wrap items-end gap-group">
						<label className="text-sm">
							Provider
							<select
								aria-label="Provider"
								className="ml-item rounded border bg-background p-2"
								value={provider ?? ""}
								onChange={(e) => select(e.target.value, null)}
							>
								{providers.map((row) => (
									<option key={row.provider} value={row.provider}>
										{row.label}
									</option>
								))}
							</select>
						</label>
						<label className="text-sm">
							Model
							<select
								aria-label="Model"
								className="ml-item rounded border bg-background p-2"
								value={selected?.model ?? ""}
								onChange={(e) => select(provider ?? "", e.target.value || null)}
							>
								{models.map((row) => (
									<option key={row.id} value={row.model ?? ""}>
										{row.model ? row.label : "All models"}
									</option>
								))}
							</select>
						</label>
						<label className="text-sm">
							Window
							<select
								aria-label="Quota window"
								className="ml-item rounded border bg-background p-2"
								disabled={!!selected?.model}
								value={selected?.model ? "seven_day" : window}
								onChange={(e) => setWindow(e.target.value as typeof window)}
							>
								<option value="seven_day">Weekly</option>
								<option value="five_hour">5 hours</option>
							</select>
						</label>
						<TimeRangeSelector value={range} onChange={setRange} />
					</div>
					<div className="mb-group flex flex-wrap gap-group text-sm">
						<label className="flex items-center gap-item">
							<input
								type="checkbox"
								checked={showForecast}
								onChange={(e) => setShowForecast(e.target.checked)}
							/>
							Show forecast
						</label>
						<label className="flex items-center gap-item">
							<input
								type="checkbox"
								checked={showAccounts}
								onChange={(e) => setShowAccounts(e.target.checked)}
							/>
							Show account lines
						</label>
					</div>
					{selected && (
						<FocusedQuotaChart
							accounts={accounts}
							now={summary.now}
							window={forecastWindow}
							history={history.data}
							scopedHistory={scoped.data}
							loading={availability.state === "loading"}
							unavailableReason={
								availability.state === "unavailable"
									? "Usage history unavailable"
									: undefined
							}
							showForecast={showForecast}
							showAccounts={showAccounts}
						/>
					)}
					{showForecast && (
						<p className="mt-item text-xs text-muted-foreground">
							Dashed lines assume the current pace continues. Missing evidence
							leaves a gap; resets do not guarantee future availability.
						</p>
					)}
					{availability.state === "stale" && (
						<p className="mt-item text-xs text-warning-strong">
							Showing saved history; refresh failed.
						</p>
					)}
				</CardContent>
			</Card>
			{selected && (
				<Card id="accounts">
					<CardHeader>
						<CardTitle>{selected.label} accounts</CardTitle>
					</CardHeader>
					<CardContent>
						<QuotaAccountTable row={selected} now={summary.now} />
					</CardContent>
				</Card>
			)}
		</div>
	);
});
