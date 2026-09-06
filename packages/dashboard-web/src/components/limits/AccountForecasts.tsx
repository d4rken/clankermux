import type { RunwayWindowSummary } from "@clankermux/types";
import { windowForecastMessage } from "../../lib/window-forecast-display";

export interface ForecastAccount {
	id: string;
	name: string;
	windows?: RunwayWindowSummary[];
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
							<th scope="col" className="p-item">
								5-hour forecast
							</th>
							<th scope="col" className="p-item">
								Weekly forecast
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((account) => (
							<tr key={account.id} className="border-b border-border/50">
								<th scope="row" className="p-item font-medium">
									{account.name}
								</th>
								{(["five_hour", "seven_day"] as const).map((kind) => {
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
