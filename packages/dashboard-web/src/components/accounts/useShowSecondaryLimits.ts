import { useCallback, useState } from "react";
import {
	parseSecondaryLimitIds,
	SECONDARY_LIMITS_STORAGE_KEY,
} from "../../lib/secondary-limits";

function writeToStorage(ids: Set<string>) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			SECONDARY_LIMITS_STORAGE_KEY,
			JSON.stringify([...ids]),
		);
	} catch {
		// ignore — degrade to in-memory
	}
}

/**
 * Per-account "show secondary limits" preference, persisted as a JSON array of
 * account IDs under {@link SECONDARY_LIMITS_STORAGE_KEY}. Returns `[shown,
 * toggle]` for the given account.
 */
export function useShowSecondaryLimits(
	accountId: string,
): readonly [boolean, () => void] {
	const [state, setState] = useState<Set<string>>(() => {
		if (typeof window === "undefined") return new Set();
		try {
			return new Set(
				parseSecondaryLimitIds(
					window.localStorage.getItem(SECONDARY_LIMITS_STORAGE_KEY),
				),
			);
		} catch {
			// localStorage can throw (e.g. Safari private mode) — degrade to in-memory
			return new Set();
		}
	});

	const shown = state.has(accountId);

	const toggle = useCallback(() => {
		setState((prev) => {
			const next = new Set(prev);
			if (next.has(accountId)) {
				next.delete(accountId);
			} else {
				next.add(accountId);
			}
			writeToStorage(next);
			return next;
		});
	}, [accountId]);

	return [shown, toggle] as const;
}
