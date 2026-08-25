import { NO_ACCOUNT_ID, type RecentErrorGroup } from "@clankermux/types";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "clankermux:dismissed-errors";
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One dismissed error group.
 *
 * The two timestamps come from different clocks and are never compared to each
 * other. `cutoff` is server-issued and only ever compared to another
 * server-issued `latestTimestamp`; `dismissedAt` is the local clock and only
 * ever feeds the prune. Collapsing them into a single `Date.now()` marker (what
 * this used to store) compares a browser clock against a server one: a browser
 * running fast writes a cutoff in the server's future and keeps recurrences
 * hidden until the server catches up, which is exactly what the recurrence
 * behaviour is supposed to prevent.
 */
interface Dismissal {
	/** Newest server `latestTimestamp` this group has been dismissed through. */
	cutoff: number;
	/** Local clock at dismissal time. Prune input only. */
	dismissedAt: number;
}

type DismissalState = Record<string, Dismissal>;

function keyFor(group: RecentErrorGroup): string {
	return `${group.accountId ?? NO_ACCOUNT_ID}:${group.errorCode}`;
}

/**
 * Accepts the legacy single-number encoding written before the two clocks were
 * split apart. That number was `Date.now()` at dismissal, so it is the better
 * estimate of `dismissedAt`; reusing it as `cutoff` preserves what the user
 * had hidden and self-corrects the moment the group is dismissed again.
 */
function parseEntry(value: unknown): Dismissal | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { cutoff: value, dismissedAt: value };
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const { cutoff, dismissedAt } = value as Record<string, unknown>;
		if (
			typeof cutoff === "number" &&
			Number.isFinite(cutoff) &&
			typeof dismissedAt === "number" &&
			Number.isFinite(dismissedAt)
		) {
			return { cutoff, dismissedAt };
		}
	}
	return null;
}

/** Reads and prunes. Pure with respect to storage — never writes. */
export function readDismissals(
	raw: string | null,
	now: number,
): DismissalState {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const cleaned: DismissalState = {};
		for (const [key, value] of Object.entries(parsed)) {
			const entry = parseEntry(value);
			if (entry && entry.dismissedAt + PRUNE_AFTER_MS > now) {
				cleaned[key] = entry;
			}
		}
		return cleaned;
	} catch {
		return {};
	}
}

/**
 * Union of two dismissal maps, keeping the later cutoff per key.
 *
 * Every write goes through this against a fresh read of storage: each tab holds
 * its own copy of the map and persists the whole object, so a tab that had been
 * open across another tab's dismissals would otherwise erase them. Merging only
 * ever adds — a dismissal made anywhere survives, at the cost of not being able
 * to propagate a removal, which nothing does outside the prune.
 */
export function mergeDismissals(
	a: DismissalState,
	b: DismissalState,
): DismissalState {
	const merged: DismissalState = { ...a };
	for (const [key, entry] of Object.entries(b)) {
		const existing = merged[key];
		merged[key] = existing
			? {
					cutoff: Math.max(existing.cutoff, entry.cutoff),
					dismissedAt: Math.max(existing.dismissedAt, entry.dismissedAt),
				}
			: entry;
	}
	return merged;
}

/**
 * Pure state transition: stamp a dismissal for every supplied group.
 *
 * Exported for tests, and kept batchable so "Clear all" is one state update and
 * one storage write rather than one per row.
 */
export function markDismissed(
	state: DismissalState,
	groups: readonly RecentErrorGroup[],
	now: number,
): DismissalState {
	// Identity-stable for an empty batch so a no-op click cannot re-render or
	// rewrite storage.
	if (groups.length === 0) return state;
	const next = { ...state };
	for (const group of groups) {
		const key = keyFor(group);
		const existing = next[key];
		next[key] = {
			// Monotonic: a stale payload carrying an older occurrence must not
			// un-hide the newer ones an earlier dismissal already covered.
			cutoff: Math.max(
				existing?.cutoff ?? Number.NEGATIVE_INFINITY,
				group.latestTimestamp,
			),
			dismissedAt: now,
		};
	}
	return next;
}

function readFromStorage(now: number): DismissalState {
	if (typeof window === "undefined") return {};
	try {
		return readDismissals(window.localStorage.getItem(STORAGE_KEY), now);
	} catch {
		return {};
	}
}

function writeToStorage(state: DismissalState) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// ignore — degrade to in-memory
	}
}

export function useDismissedErrors() {
	const [state, setState] = useState<DismissalState>(() =>
		readFromStorage(Date.now()),
	);

	// Persist the (possibly pruned) initial state back to storage once on mount.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount to persist the pruned initial state
	useEffect(() => {
		writeToStorage(state);
	}, []);

	// Another tab dismissing something has to reach this one, or the two windows
	// keep showing different lists until one of them is reloaded.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onStorage = (event: StorageEvent) => {
			if (event.key !== null && event.key !== STORAGE_KEY) return;
			const persisted = readFromStorage(Date.now());
			setState((prev) => mergeDismissals(prev, persisted));
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const dismissMany = useCallback((groups: readonly RecentErrorGroup[]) => {
		setState((prev) => {
			const now = Date.now();
			const base = mergeDismissals(prev, readFromStorage(now));
			const next = markDismissed(base, groups, now);
			if (next === base && base === prev) return prev;
			writeToStorage(next);
			return next;
		});
	}, []);

	const dismiss = useCallback(
		(group: RecentErrorGroup) => dismissMany([group]),
		[dismissMany],
	);

	const isDismissed = useCallback(
		(group: RecentErrorGroup) => {
			const entry = state[keyFor(group)];
			return entry != null && group.latestTimestamp <= entry.cutoff;
		},
		[state],
	);

	return { dismiss, dismissMany, isDismissed };
}
