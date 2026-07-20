import type { TimeRange } from "../../constants";
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
export function CacheKeepaliveSection({ range }: { range: TimeRange }) {
	return (
		<section className="space-y-6 border-t pt-6">
			<div>
				<h2 className="text-lg font-semibold">Cache Keep-Alive</h2>
				<p className="text-sm text-muted-foreground max-w-prose">
					Live cache status, historical activity, and effectiveness. The
					selected window applies to history and effectiveness; live counters
					are cumulative since the last restart.
				</p>
			</div>
			<CacheKeepalivePanel range={range} />
			<CacheEffectivenessPanel range={range} />
		</section>
	);
}
