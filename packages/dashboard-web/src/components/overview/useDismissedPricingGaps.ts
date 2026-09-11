import type { PricingGap } from "@clankermux/types";
import { useCallback, useEffect, useState } from "react";

export const PRICING_GAP_DISMISSALS_KEY = "clankermux:dismissed-pricing-gaps";
const MAX_DISMISSALS = 512;
interface Dismissal {
	lastSeenAt: number;
	occurrences: number;
}
type Dismissals = Record<string, Dismissal>;

// firstSeenAt distinguishes a fresh registry entry after eviction or restart.
function keyFor(gap: PricingGap): string {
	return `${gap.key}:${gap.firstSeenAt}`;
}

function readStorage(): Dismissals {
	try {
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(PRICING_GAP_DISMISSALS_KEY) ?? "{}",
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};
		const result: Dismissals = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (
				!/^[a-f0-9]{64}:\d+$/.test(key) ||
				!value ||
				typeof value !== "object"
			)
				continue;
			const { lastSeenAt, occurrences } = value as Partial<Dismissal>;
			if (
				typeof lastSeenAt === "number" &&
				Number.isFinite(lastSeenAt) &&
				typeof occurrences === "number" &&
				Number.isSafeInteger(occurrences) &&
				occurrences > 0
			) {
				result[key] = { lastSeenAt, occurrences };
			}
		}
		return result;
	} catch {
		// Includes SSR and browsers that block storage. Dismissals still work in memory.
		return {};
	}
}

function merge(a: Dismissals, b: Dismissals): Dismissals {
	const next = { ...a };
	for (const [key, value] of Object.entries(b)) {
		const previous = next[key];
		next[key] = {
			lastSeenAt: Math.max(previous?.lastSeenAt ?? 0, value.lastSeenAt),
			occurrences: Math.max(previous?.occurrences ?? 0, value.occurrences),
		};
	}
	// Keep storage bounded across process restarts and changing model names.
	return Object.fromEntries(
		Object.entries(next)
			.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
			.slice(0, MAX_DISMISSALS),
	);
}

export function useDismissedPricingGaps() {
	const [state, setState] = useState(readStorage);
	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key === null || event.key === PRICING_GAP_DISMISSALS_KEY) {
				setState((previous) => merge(previous, readStorage()));
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const dismiss = useCallback((gaps: readonly PricingGap[]) => {
		setState((previous) => {
			const observed = Object.fromEntries(
				gaps.map((gap) => [
					keyFor(gap),
					{
						lastSeenAt: gap.lastSeenAt,
						occurrences: gap.occurrences,
					},
				]),
			);
			// Preserve another tab's dismissals when writing our current snapshot.
			const next = merge(merge(previous, readStorage()), observed);
			try {
				window.localStorage.setItem(
					PRICING_GAP_DISMISSALS_KEY,
					JSON.stringify(next),
				);
			} catch {
				// Fall back to this component's in-memory state.
			}
			return next;
		});
	}, []);

	const isDismissed = useCallback(
		(gap: PricingGap) => {
			const entry = state[keyFor(gap)];
			// Count catches multiple requests recorded during the same millisecond.
			return (
				entry !== undefined &&
				gap.lastSeenAt <= entry.lastSeenAt &&
				gap.occurrences <= entry.occurrences
			);
		},
		[state],
	);
	return { dismiss, isDismissed };
}
