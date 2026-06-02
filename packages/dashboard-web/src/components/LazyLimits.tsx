import { Suspense } from "react";
import { LimitsTab } from "./limits/LimitsTab";
import { LoadingSkeleton } from "./overview/LoadingSkeleton";

// Lazy loaded Limits component for code splitting
export const LazyLimits = () => (
	<Suspense fallback={<LoadingSkeleton />}>
		<LimitsTab />
	</Suspense>
);
