import type { ModelSubstitutionPair } from "@clankermux/types";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "clankermux.acknowledged-model-substitutions";

/**
 * Which (account, sent model, served model) triples the viewer has already been
 * told about.
 *
 * Identity is the TRIPLE ALONE — deliberately not the triple plus an occurrence
 * count, which is how the pricing-gap banner works. That rule re-opens a
 * dismissed warning on every new occurrence, which is right for a rare event
 * and wrong here: substitution has been measured at ~87% of one account's
 * requests, so a count-sensitive rule would re-raise the banner within seconds
 * of every dismissal and become wallpaper.
 *
 * So the banner answers "has a pair I have never seen before appeared?", and
 * the standing condition belongs to the Accounts chip, which clears on its own
 * when the substitution stops.
 *
 * Browser-local and best-effort: every read and write is guarded because
 * localStorage throws in a private window and returns nothing after site data
 * is cleared. Losing it re-shows a banner, which is the safe direction.
 */
export function pairKey(pair: ModelSubstitutionPair): string {
	return `${pair.accountId}\u0000${pair.outgoingModel}\u0000${pair.reportedModel}`;
}

function readStorage(): Record<string, true> {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return {};
		const out: Record<string, true> = {};
		for (const key of Object.keys(parsed as Record<string, unknown>))
			out[key] = true;
		return out;
	} catch {
		return {};
	}
}

export function useAcknowledgedSubstitutions() {
	const [state, setState] = useState<Record<string, true>>({});

	useEffect(() => {
		setState(readStorage());
	}, []);

	const acknowledge = useCallback((pairs: readonly ModelSubstitutionPair[]) => {
		setState((previous) => {
			const next = { ...previous, ...readStorage() };
			for (const pair of pairs) next[pairKey(pair)] = true;
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				// Fall back to this component's in-memory state.
			}
			return next;
		});
	}, []);

	const isAcknowledged = useCallback(
		(pair: ModelSubstitutionPair) => state[pairKey(pair)] === true,
		[state],
	);

	return { acknowledge, isAcknowledged };
}
