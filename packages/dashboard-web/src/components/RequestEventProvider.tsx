import type { RequestStreamEvt } from "@clankermux/core";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { api } from "../api";
import { useAccounts } from "../hooks/queries";
import {
	type LiveActivitySnapshot,
	LiveActivityStore,
} from "../lib/live-activity-store";
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

/** How much history to pull to prime the lanes. */
export const BACKFILL_LIMIT = 50;
/** Housekeeping cadence: prune the window, settle stale in-flight entries. */
const TICK_INTERVAL_MS = 1000;
/** Rolling window the lanes render. */
export const LIVE_WINDOW_MS = 180_000;

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

const RequestEventContext = createContext<RequestEventFeed | null>(null);

export function RequestEventProvider({ children }: { children: ReactNode }) {
	const { data: accounts } = useAccounts();

	// Read through a ref so the store's normalizer always sees the CURRENT
	// account list without the store having to be rebuilt when it loads.
	const accountsRef = useRef(accounts);
	accountsRef.current = accounts;

	const feed = useMemo(
		() =>
			new RequestEventFeed(
				new LiveActivityStore(LIVE_WINDOW_MS, {
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
		// Bumped on every (re)connect so a backfill response that arrives after
		// a later reconnect cannot be mistaken for that reconnect's own.
		let generation = 0;

		/**
		 * Pull recent history and merge it in.
		 *
		 * Runs on mount AND on every reconnect. Deliberately its own fetch
		 * rather than the shared `useRequests` query: that one is
		 * `staleTime: Infinity` with a 10-minute `gcTime`, so returning to the
		 * dashboard after five minutes away would reuse a five-minute-old cache
		 * and render the gap as inactivity rather than as missing history.
		 */
		const backfill = async () => {
			const mine = generation;
			try {
				const rows = await api.getRequestsSummary(BACKFILL_LIMIT);
				if (!mounted || mine !== generation) return;
				// A full page means older in-window history exists that we
				// cannot see; a short page means the history really is complete.
				store.applyHistory(rows, rows.length >= BACKFILL_LIMIT);
			} catch {
				// A failed backfill is not fatal — the live stream still works,
				// and the next reconnect tries again. Leaving `primed` unset
				// keeps the lanes in their loading state rather than asserting
				// an empty history.
			}
		};

		const release = () => {
			current = null;
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
				generation++;
				store.setConnected(true);
				void backfill();
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
			clearInterval(tick);
			if (reconnectTimer !== null) clearTimeout(reconnectTimer);
			current?.close();
			current = null;
			store.dispose();
		};
	}, [feed]);

	return (
		<RequestEventContext.Provider value={feed}>
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
	const feed = useContext(RequestEventContext);
	const listenerRef = useRef(listener);
	listenerRef.current = listener;

	useEffect(() => {
		if (!feed || !enabled) return;
		return feed.subscribeRaw((evt) => listenerRef.current(evt));
	}, [feed, enabled]);
}

const DETACHED_SNAPSHOT: LiveActivitySnapshot = {
	events: [],
	connected: false,
	outages: [],
	primed: false,
	historyEdge: null,
};

/** Current live-activity view. Empty and unprimed when no provider is mounted. */
export function useLiveActivity(): LiveActivitySnapshot {
	const feed = useContext(RequestEventContext);
	return useSyncExternalStore(
		feed ? feed.store.subscribe : noopSubscribe,
		feed ? feed.store.getSnapshot : () => DETACHED_SNAPSHOT,
		() => DETACHED_SNAPSHOT,
	);
}

function noopSubscribe(): () => void {
	return () => {};
}
