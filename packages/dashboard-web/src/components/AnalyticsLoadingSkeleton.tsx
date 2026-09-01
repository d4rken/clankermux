import { Skeleton } from "./ui/skeleton";

/**
 * Suspense fallback for the lazily-loaded Analytics route.
 *
 * It stands in for what the route actually paints: a five-tab strip, the
 * control row under it, and one tab's content. It used to draw a header row, a
 * 4-up metric grid and four chart blocks — and there is no 4-up metric grid
 * anywhere in Analytics, so the layout visibly rearranged itself the moment the
 * chunk arrived.
 *
 * One chart block, not several: which tab loads is not known here, and every
 * tab opens with a single full-width panel.
 */
export function AnalyticsLoadingSkeleton() {
	return (
		<div className="space-y-section">
			{/* Tab strip */}
			<Skeleton className="h-10 w-full" />

			{/* Controls: range picker, Filters, Refresh */}
			<div className="flex gap-group">
				<Skeleton className="h-10 w-48" />
				<Skeleton className="h-10 w-32" />
				<Skeleton className="h-10 w-24" />
			</div>

			{/* First panel */}
			<Skeleton className="h-64 w-full" />
		</div>
	);
}
