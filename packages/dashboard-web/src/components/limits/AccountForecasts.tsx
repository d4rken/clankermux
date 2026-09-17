import type { RunwayWindowKind, RunwayWindowSummary } from "@clankermux/types";
import { runwayWindowLabel } from "../../lib/runway-display";
import { windowForecastMessage } from "../../lib/window-forecast-display";

export interface ForecastAccount {
	id: string;
	name: string;
	windows?: RunwayWindowSummary[];
}

/**
 * Column order: shortest window first, so a row reads left to right from the
 * constraint that bites soonest to the one that bites last.
 */
const WINDOW_ORDER: readonly RunwayWindowKind[] = [
	"five_hour",
	"daily",
	"seven_day",
];

/**
 * The windows any listed account actually reports.
 *
 * Derived rather than fixed at 5-hour and weekly. A provider whose short window
 * is a calendar day has no 5-hour one, and with the columns fixed its daily
 * window had nowhere to appear — the table showed that account's comfortable
 * weekly forecast and silently omitted the exhausted daily window beside it. A
 * column nobody reports is left out entirely rather than printed as a row of
 * "Not reported".
 */
function columnsFor(accounts: ForecastAccount[]): RunwayWindowKind[] {
	const present = new Set(
		accounts.flatMap((account) => account.windows ?? []).map((w) => w.kind),
	);
	return WINDOW_ORDER.filter((kind) => present.has(kind));
}

/** Per-window evidence stays visible even when the combined runway is unknown. */
export function AccountForecasts({
	accounts,
	now,
}: {
	accounts: ForecastAccount[];
	now: number;
}) {
	const rows = accounts.filter((account) => account.windows?.length);
	if (rows.length === 0) return null;
	const columns = columnsFor(rows);
	return (
		<section className="mt-row space-y-item" aria-label="Account forecasts">
			<h4 className="text-sm font-medium">Account forecasts</h4>
			<p className="text-xs text-muted-foreground">
				Each window is estimated separately. A learning window keeps the
				combined account runway unknown.
			</p>
			<div className="overflow-x-auto">
				<table className="w-full text-left text-xs">
					<thead>
						<tr className="border-b">
							<th scope="col" className="p-item">
								Account
							</th>
							{columns.map((kind) => (
								<th key={kind} scope="col" className="p-item capitalize">
									{runwayWindowLabel(kind)} forecast
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((account) => (
							<tr key={account.id} className="border-b border-border/50">
								<th scope="row" className="p-item font-medium">
									{account.name}
								</th>
								{columns.map((kind) => {
									const window = account.windows?.find((w) => w.kind === kind);
									return (
										<td key={kind} className="p-item text-muted-foreground">
											{window
												? windowForecastMessage(window, now)
												: "Not reported"}
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
}
