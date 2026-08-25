import type { RecentErrorGroup } from "@clankermux/types";
import { useCallback, useMemo } from "react";
import { useDismissedErrors } from "./useDismissedErrors";

/**
 * Apply the shared dismissal state to a batch of recent-error groups once, so
 * every consumer sees the same list.
 *
 * `useDismissedErrors` keeps its own React state per call site (backed by a
 * shared localStorage key), so two independent callers would drift the moment
 * one of them dismissed something — the Overview strip's count would keep
 * claiming errors the list below it had already hidden. Calling this once at
 * the page level and passing the result down keeps them in lockstep.
 */
export function useVisibleRecentErrors(
	groups: RecentErrorGroup[] | undefined,
): {
	visible: RecentErrorGroup[];
	dismiss: (group: RecentErrorGroup) => void;
	dismissAll: () => void;
} {
	const { dismiss, dismissMany, isDismissed } = useDismissedErrors();

	const visible = useMemo(
		() => (groups ?? []).filter((group) => !isDismissed(group)),
		[groups, isDismissed],
	);

	// Dismisses what is currently visible, not what is currently rendered:
	// the Overview list caps itself at a few rows, and a "Clear all" that left
	// the overflow behind would repopulate the list the moment it re-rendered.
	const dismissAll = useCallback(
		() => dismissMany(visible),
		[dismissMany, visible],
	);

	return { visible, dismiss, dismissAll };
}
