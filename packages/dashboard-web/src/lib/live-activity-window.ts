/**
 * Window sizing for the Overview's Live Activity card.
 *
 * The window is selectable because the right length depends on what you are
 * doing: a short window shows individual requests, bursts and stalls; a long
 * one shows which project has been dominating and whether there was a gap. They
 * are different questions and no single default answers both.
 *
 * Everything the window couples to lives here — how much history to fetch, and
 * how many events to retain — because those are not free parameters. Sizing
 * them independently of the window is how the card ends up either half empty or
 * quietly dropping events.
 */

export interface LiveWindowOption {
	ms: number;
	/** Compact label for the selector. */
	label: string;
}

export const LIVE_WINDOW_OPTIONS: readonly LiveWindowOption[] = [
	{ ms: 3 * 60_000, label: "3m" },
	{ ms: 5 * 60_000, label: "5m" },
	{ ms: 10 * 60_000, label: "10m" },
	{ ms: 30 * 60_000, label: "30m" },
] as const;

/**
 * Five minutes rather than three: at a few tens of requests per minute, three
 * minutes is thin enough that a brief pause empties the card, while five still
 * leaves roughly 3px per mark — enough for bursts and gaps to stay legible.
 */
export const DEFAULT_LIVE_WINDOW_MS = 5 * 60_000;

const STORAGE_KEY = "clankermux.liveActivityWindowMs";

/** `/api/requests` rejects anything larger. */
export const MAX_BACKFILL_ROWS = 1000;

/** Hard ceiling on retained events, whatever the window. */
export const MAX_EVENT_CAP = 3000;

function isKnownWindow(ms: number): boolean {
	return LIVE_WINDOW_OPTIONS.some((option) => option.ms === ms);
}

/**
 * Restore the persisted window, falling back to the default for anything
 * unrecognised — including a value from an older build whose option has since
 * been removed.
 */
export function loadLiveWindow(storage?: Pick<Storage, "getItem">): number {
	const store = storage ?? safeStorage();
	if (!store) return DEFAULT_LIVE_WINDOW_MS;
	try {
		const raw = store.getItem(STORAGE_KEY);
		if (!raw) return DEFAULT_LIVE_WINDOW_MS;
		const parsed = Number(raw);
		return isKnownWindow(parsed) ? parsed : DEFAULT_LIVE_WINDOW_MS;
	} catch {
		return DEFAULT_LIVE_WINDOW_MS;
	}
}

/** Persist the chosen window. Silently a no-op where storage is unavailable. */
export function saveLiveWindow(
	ms: number,
	storage?: Pick<Storage, "setItem">,
): void {
	const store = storage ?? safeStorage();
	if (!store) return;
	try {
		store.setItem(STORAGE_KEY, String(ms));
	} catch {
		// Private browsing, quota, or no DOM. The window still applies for this
		// session; only the memory of it is lost.
	}
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/**
 * Row cap for the history backfill.
 *
 * A cap, not a target: the backfill asks for everything since the window
 * started (`from=`), so it fetches what the window actually contains rather
 * than a fixed guess. This only bounds the response when traffic is heavier
 * than the allowance, and the card discloses that case by hatching the part of
 * the timeline the fetch could not reach.
 */
export function backfillLimitFor(windowMs: number): number {
	const minutes = windowMs / 60_000;
	return Math.min(MAX_BACKFILL_ROWS, Math.max(120, Math.ceil(minutes * 150)));
}

/**
 * Retained-event ceiling.
 *
 * Must exceed what the backfill can deliver, or the fetched history would be
 * pruned the moment it landed.
 */
export function eventCapFor(windowMs: number): number {
	const minutes = windowMs / 60_000;
	return Math.min(MAX_EVENT_CAP, Math.max(1500, Math.ceil(minutes * 150)));
}
