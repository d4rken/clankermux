import type { RequestStreamEvt } from "@clankermux/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Account, RequestPayload, RequestResponse } from "../api";
import { useRequestEvents } from "../components/RequestEventProvider";
import { queryKeys } from "../lib/query-keys";
import { toDetailsMap } from "./queries";

/**
 * Keeps the Requests tab's live tail in sync with the request stream.
 *
 * This used to own a module-level `EventSource` pool as well. The connection
 * now belongs to `RequestEventProvider` at the app root, and this hook is
 * purely the React Query cache patcher on top of it — which also fixes a
 * latent bug in the pool: it returned an already-open pooled connection before
 * attaching the caller's `message` listener, so a second consumer silently
 * received nothing.
 *
 * `enabled` therefore now suppresses the PATCHING, not the connection: the
 * stream stays open so the Overview's activity lanes keep filling while the
 * Requests tab has server-side filters applied and its list must stay a stable
 * snapshot. Nothing is lost by that — `useRequests` is `staleTime: Infinity`,
 * so re-enabling never refetched what the pause missed under the old behaviour
 * either.
 */
export function useRequestStream(limit = 200, enabled = true) {
	const queryClient = useQueryClient();

	const handleEvent = useCallback(
		(evt: RequestStreamEvt) => {
			// `ingress`, `ingress-end` and `snapshot` describe work that has no
			// Request History row yet; the tail only shows recorded requests.
			if (evt.type !== "start" && evt.type !== "summary") return;

			queryClient.setQueryData(
				queryKeys.requests(limit),
				(
					current:
						| {
								requests: RequestPayload[];
								detailsMap: Map<string, RequestResponse> | RequestResponse[];
						  }
						| undefined,
				) => {
					if (!current) return current;

					// Ensure detailsMap is a Map
					const currentDetailsMap = toDetailsMap<RequestResponse>(
						current.detailsMap,
					);

					if (evt.type === "start") {
						// Look up account name from cache
						const accounts = queryClient.getQueryData<Account[]>(
							queryKeys.accounts(),
						);
						const account = accounts?.find((a) => a.id === evt.accountId);

						// Create a lightweight placeholder payload.
						// `bodiesOmitted: true` is required so that opening the
						// details modal or pressing Copy-as-JSON triggers the
						// lazy /api/requests/payload/:id fetch — without it the
						// modal shows empty headers/body and the copy returns
						// nulled-out bodies.
						//
						// `response: null` when no status is known yet so the
						// status chip (guarded by `statusCode != null`) does NOT
						// render a "0" before the response lands. The summary
						// handler below patches response.status from
						// `evt.payload.statusCode` once the request completes.
						const hasStatus = evt.statusCode > 0;
						const placeholder: RequestPayload = {
							id: evt.id,
							request: { headers: {}, body: null },
							response: hasStatus
								? {
										status: evt.statusCode,
										headers: {},
										body: null,
									}
								: null,
							meta: {
								timestamp: evt.timestamp,
								path: evt.path,
								method: evt.method,
								accountId: evt.accountId || undefined,
								accountName: account?.name,
								success: false,
								pending: true,
								rateLimited: evt.statusCode === 429,
								bodiesOmitted: true,
							},
						};

						// Check if this request already exists
						const existingIndex = current.requests.findIndex(
							(r) => r.id === evt.id,
						);
						if (existingIndex >= 0) {
							// Update existing placeholder
							const newRequests = [...current.requests];
							newRequests[existingIndex] = placeholder;
							return {
								...current,
								requests: newRequests,
								detailsMap: currentDetailsMap,
							};
						}

						// Add new placeholder at the beginning
						return {
							...current,
							requests: [placeholder, ...current.requests].slice(0, limit),
							detailsMap: currentDetailsMap,
						};
					}

					// Update details map with summary
					const map = new Map(currentDetailsMap);
					map.set(evt.payload.id, evt.payload);

					// Update the request if it exists
					const requestIndex = current.requests.findIndex(
						(r) => r.id === evt.payload.id,
					);
					if (requestIndex >= 0) {
						const newRequests = [...current.requests];
						// Update meta to remove pending status. Preserve
						// `bodiesOmitted: true` so consumers continue to lazy-
						// load bodies, and refresh `rateLimited` from the final
						// statusCode (the placeholder set it from `evt.statusCode`
						// which is 0 until the response lands).
						if (newRequests[requestIndex].meta) {
							newRequests[requestIndex] = {
								...newRequests[requestIndex],
								// Refresh response.status from the final summary —
								// the start placeholder set it to 0 before the HTTP
								// response landed, and the new header-row chip uses
								// a `statusCode != null` guard (0 is not null), so
								// without this every SSE-completed request would
								// permanently display a grey "0" chip.
								response:
									evt.payload.statusCode != null
										? {
												...(newRequests[requestIndex].response ?? {
													headers: {},
													body: null,
												}),
												status: evt.payload.statusCode,
											}
										: null,
								meta: {
									...newRequests[requestIndex].meta,
									pending: false,
									success: evt.payload.success,
									rateLimited: evt.payload.rateLimited,
									bodiesOmitted: true,
								},
							};
						}
						return { ...current, requests: newRequests, detailsMap: map };
					}

					return { ...current, detailsMap: map };
				},
			);
		},
		[queryClient, limit],
	);

	useRequestEvents(handleEvent, enabled);
}
