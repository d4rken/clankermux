import type { AnalyticsResponse, AnalyticsSection } from "@clankermux/types";
import { AlertCircle } from "lucide-react";
import { hasSection } from "../../lib/analytics-sections";
import { Card } from "../ui/card";

interface MissingSectionsNoticeProps {
	analytics: AnalyticsResponse | undefined;
	/** The sections this view asked the server for. */
	requested: readonly AnalyticsSection[];
}

/**
 * Warn when the server did not compute a section this view requested.
 *
 * Section-scoped responses OMIT a section rather than zero-filling it, so a
 * panel fed by a missing section renders empty — visually identical to "no data
 * in this range", which is the opposite conclusion. `meta.sections` carries the
 * set the server actually computed, so the two cases are distinguishable; this
 * says which one it is.
 *
 * In normal operation this never appears: each caller requests exactly the
 * sections it renders. It fires on a client/server version skew — the case that
 * would otherwise present as silently blank panels.
 */
export function MissingSectionsNotice({
	analytics,
	requested,
}: MissingSectionsNoticeProps) {
	if (!analytics) return null;
	const missing = requested.filter(
		(section) => !hasSection(analytics, section),
	);
	if (missing.length === 0) return null;

	return (
		<Card
			role="alert"
			className="flex items-start gap-3 px-4 py-3 text-sm bg-warning/10 border-warning/30"
		>
			<AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-warning" />
			<div>
				<p className="font-medium">Some panels are unavailable</p>
				<p className="text-muted-foreground">
					The server did not return: {missing.join(", ")}. Panels backed by
					those are blank because the data is missing, not because the range is
					empty.
				</p>
			</div>
		</Card>
	);
}
