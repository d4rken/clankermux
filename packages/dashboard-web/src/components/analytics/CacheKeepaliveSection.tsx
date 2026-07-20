import { useState } from "react";
import type { TimeRange } from "../../constants";
import { TimeRangeSelector } from "../overview/TimeRangeSelector";
import { CacheEffectivenessPanel } from "./CacheEffectivenessPanel";
import { CacheKeepalivePanel } from "./CacheKeepalivePanel";

/**
 * Groups the two cache-keepalive analytics panels under a single, shared
 * time-range picker.
 *
 * These panels read from append-only snapshot/sampler tables
 * (`cache_keepalive_snapshots`, `usage_snapshots`) via dedicated hooks — NOT the
 * page's shared `useAnalytics(timeRange, …)` query — so they need a range
 * independent of the global AnalyticsControls picker (which defaults to "1h",
 * where these sparse snapshot series would render empty). Rather than give each
 * card its own picker (the previous design, which put three range pickers on one
 * page with ambiguous scope), one section-scoped selector drives both.
 *
 * Scope note: the selected window drives the *history* chart and the
 * *effectiveness* summary. The live headline tiles in the first panel are
 * cumulative-since-restart and are NOT range-scoped — the description says so.
 */
export function CacheKeepaliveSection() {
	const [range, setRange] = useState<TimeRange>("7d");

	return (
		<section className="space-y-6 border-t pt-6">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 className="text-lg font-semibold">Cache Keep-Alive</h2>
					<p className="text-sm text-muted-foreground max-w-prose">
						Live cache status, historical activity, and effectiveness. The
						selected window applies to history and effectiveness; live counters
						are cumulative since the last restart.
					</p>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<span className="text-xs text-muted-foreground">Window</span>
					<TimeRangeSelector
						value={range}
						onChange={(value) => setRange(value as TimeRange)}
					/>
				</div>
			</div>
			<CacheKeepalivePanel range={range} />
			<CacheEffectivenessPanel range={range} />
		</section>
	);
}
