import type { RequestStreamEvt } from "@clankermux/core";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { api } from "../api";
import { useAccounts } from "../hooks/queries";
import {
	type LiveActivitySnapshot,
	LiveActivityStore,
} from "../lib/live-activity-store";
import {
	backfillLimitFor,
	DEFAULT_LIVE_WINDOW_MS,
	loadLiveWindow,
	saveLiveWindow,
} from "../lib/live-activity-window";
import { handleStreamError, MAX_RETRIES } from "../lib/stream-error";

/**
 * Owns the dashboard's single SSE connection to `/api/requests/stream`.
 *
 * Mounted above `<Routes>` rather than inside a page, for three reasons:
 *
 *  1. Overview and Requests are mutually exclusive routes, so a per-page
 *     connection would be torn down and re-established on every navigation —
 *     and each reconnect is a hole in the live view.
 *  2. The event history survives navigation, so arriving at the Overview from
 *     any other page shows populated lanes instead of a cold start.
 *  3. There is exactly one owner, which removes the connection pool this used
 *     to need — along with its refCounting, its zero-subscriber retention
 *     window, and the per-hook retry state that could strand a reconnect when
 *     whichever hook happened to create the connection unmounted first.
 */

/** Housekeeping cadence: prune the window, settle stale in-flight entries. */
const TICK_INTERVAL_MS = 1000;

/**
 * The connection's public surface: the reconciled live-activity store, plus a
 * raw tap for consumers that keep their own bookkeeping (the Requests tab
 * patches a React Query cache and wants the events untouched).
 */
class RequestEventFeed {
	private readonly rawListeners = new Set<(evt: RequestStreamEvt) => void>();

	constructor(readonly store: LiveActivityStore) {}

	subscribeRaw = (listener: (evt: RequestStreamEvt) => void): (() => void) => {
		this.rawListeners.add(listener);
		return () => {
			this.rawListeners.delete(listener);
		};
	};

	/** Fan one event out to the raw taps. A throwing listener must not take
	 *  down the connection or starve the listeners after it. */
	emitRaw(evt: RequestStreamEvt): void {
		for (const listener of this.rawListeners) {
			try {
				listener(evt);
			} catch (error) {
				console.error("Request stream listener failed:", error);
			}
		}
	}
}

interface RequestEventContextValue {
	feed: RequestEventFeed;
	/** Rolling window the Live Activity lanes render, in ms. */
	windowMs: number;
	setWindowMs: (ms: number) => void;
}

const RequestEventContext = createContext<RequestEventContextValue | null>(
	null,
);

export function RequestEventProvider({ children }: { children: ReactNode }) {
	const { data: accounts } = useAccounts();
	const [windowMs, setWindowMsState] = useState(loadLiveWindow);

	// Read through a ref so the store's normalizer always sees the CURRENT
	// account list without the store having to be rebuilt when it loads.
	const accountsRef = useRef(accounts);
	accountsRef.current = accounts;

	// Same trick for the window: the connection effect must not tear down and
	// re-open the EventSource just because the user changed the time scale.
	const windowRef = useRef(windowMs);
	windowRef.current = windowMs;

	// Set by the connection effect; lets the window-change effect below reuse
	// the same fetch (and the same generation guard) without duplicating it.
	const backfillRef = useRef<((since?: number) => void) | null>(null);

	const feed = useMemo(
		() =>
			new RequestEventFeed(
				new LiveActivityStore(loadLiveWindow(), {
					accountName: (id) =>
						accountsRef.current?.find((account) => account.id === id)?.name ??
						null,
				}),
			),
		[],
	);

	useEffect(() => {
		const { store } = feed;

		let mounted = true;
		let current: EventSource | null = null;
		let retryCount = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		// Bumped on every (re)connect AND on every window change, so a backfill
		// response that arrives after a later one cannot be mistaken for it.
		let generation = 0;

		/**
		 * Pull history and merge it in.
		 *
		 * Runs on mount, on every reconnect, and on every window change.
		 * Deliberately its own fetch rather than the shared `useRequests` query:
		 * that one is `staleTime: Infinity` with a 10-minute `gcTime`, so
		 * returning to the dashboard after five minutes away would reuse a
		 * five-minute-old cache and render the gap as inactivity rather than as
		 * missing history.
		 *
		 * `since` scopes the fetch server-side. On a reconnect the caller passes
		 * the moment the stream dropped, so only the gap is fetched rather than
		 * the whole window again — at a few hundred rows per window that is the
		 * difference between a few KB and a few hundred.
		 */
		const backfill = async (since?: number) => {
			generation++;
			const mine = generation;
			const currentWindow = windowRef.current;
			const limit = backfillLimitFor(currentWindow);
			const from = Math.max(since ?? 0, Date.now() - currentWindow);
			try {
				const rows = await api.getRequestsSummary(limit, { from });
				if (!mounted || mine !== generation) return;
				// A full page means older history exists inside the window that
				// we could not reach; a short page means it really is complete.
				store.applyHistory(rows, rows.length >= limit);
			} catch {
				// A failed backfill is not fatal — the live stream still works,
				// and the next reconnect tries again. Leaving `primed` unset
				// keeps the lanes in their loading state rather than asserting
				// an empty history.
			}
		};
		backfillRef.current = backfill;

		// When the stream dropped, so the reconnect can fetch only the gap.
		let droppedAt: number | null = null;

		const release = () => {
			current = null;
			if (droppedAt === null) droppedAt = Date.now();
			store.setConnected(false);
		};

		const connect = () => {
			if (!mounted) return;
			const es = new EventSource("/api/requests/stream");
			current = es;

			es.addEventListener("open", () => {
				if (!mounted) {
					es.close();
					return;
				}
				// A successful open resets the backoff, so a long session with
				// intermittent drops does not slowly exhaust MAX_RETRIES.
				retryCount = 0;
				store.setConnected(true);
				// First connect has no gap to scope to and must fetch the whole
				// window; a reconnect only needs what it missed.
				void backfill(droppedAt ?? undefined);
				droppedAt = null;
			});

			es.addEventListener("message", (event) => {
				if (!mounted) return;
				let parsed: RequestStreamEvt;
				try {
					parsed = JSON.parse(event.data) as RequestStreamEvt;
				} catch {
					return; // A malformed frame must not kill the stream.
				}
				store.applyEvent(parsed);
				feed.emitRaw(parsed);
			});

			es.addEventListener("error", () => {
				const outcome = handleStreamError(es, {
					current,
					release,
					mounted,
					retryCount,
					scheduleReconnect: (nextRetryCount, delay) => {
						retryCount = nextRetryCount;
						reconnectTimer = setTimeout(connect, delay);
					},
				});
				if (outcome === "gave-up") {
					console.error(`Request stream gave up after ${MAX_RETRIES} retries`);
				}
			});
		};

		connect();
		const tick = setInterval(() => store.tick(), TICK_INTERVAL_MS);

		return () => {
			mounted = false;
			backfillRef.current = null;
			clearInterval(tick);
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			current?.close();
			current = null;
			store.dispose();
		};
	}, [feed]);

	const setWindowMs = useCallback(
		(next: number) => {
			const widening = next > windowRef.current;
			setWindowMsState(next);
			saveLiveWindow(next);
			windowRef.current = next;
			feed.store.setWindow(next);
			// Only widening needs a fetch: it exposes a stretch of timeline
			// nothing has been fetched for. Narrowing can only ever remove marks
			// already held, so refetching there would just re-download what is
			// about to be pruned.
			if (widening) backfillRef.current?.();
		},
		[feed],
	);

	const value = useMemo(
		() => ({ feed, windowMs, setWindowMs }),
		[feed, windowMs, setWindowMs],
	);

	return (
		<RequestEventContext.Provider value={value}>
			{children}
		</RequestEventContext.Provider>
	);
}

/**
 * Raw event tap. Returns a no-op unsubscribe when no provider is mounted, so a
 * component rendered in isolation (tests, Storybook) degrades to inert rather
 * than throwing.
 */
export function useRequestEvents(
	listener: (evt: RequestStreamEvt) => void,
	enabled = true,
): void {
	const context = useContext(RequestEventContext);
	const feed = context?.feed ?? null;
	const listenerRef = useRef(listener);
	listenerRef.current = listener;

	useEffect(() => {
		if (!feed || !enabled) return;
		return feed.subscribeRaw((evt) => listenerRef.current(evt));
	}, [feed, enabled]);
}

/**
 * The selected window and its setter. Falls back to the default (and a no-op
 * setter) when no provider is mounted, so an isolated render stays inert.
 */
export function useLiveWindow(): {
	windowMs: number;
	setWindowMs: (ms: number) => void;
} {
	const context = useContext(RequestEventContext);
	return {
		windowMs: context?.windowMs ?? DEFAULT_LIVE_WINDOW_MS,
		setWindowMs: context?.setWindowMs ?? noop,
	};
}

function noop(): void {}

const DETACHED_SNAPSHOT: LiveActivitySnapshot = {
	events: [],
	connected: false,
	outages: [],
	primed: false,
	historyEdge: null,
};

/** Current live-activity view. Empty and unprimed when no provider is mounted. */
export function useLiveActivity(): LiveActivitySnapshot {
	const context = useContext(RequestEventContext);
	const store = context?.feed.store ?? null;
	return useSyncExternalStore(
		store ? store.subscribe : noopSubscribe,
		store ? store.getSnapshot : () => DETACHED_SNAPSHOT,
		() => DETACHED_SNAPSHOT,
	);
}

function noopSubscribe(): () => void {
	return () => {};
}
