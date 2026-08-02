/**
 * The generic client-departed terminal: returned wherever the proxy observes
 * that the CLIENT disconnected — a burst-retry / overload / context-window hold
 * giving up mid-hold, an attempt aborted in flight, or a disconnect detected at
 * account selection or at the request-level tail.
 *
 * The client is already gone, so the body is never read — we only need a
 * terminal Response so the handler stops WITHOUT issuing further sibling/Codex
 * upstream requests, recording a synthetic failure row, or throwing an aggregate
 * error for a request nobody is waiting on. Uses 499 (Client Closed Request) so
 * history/logs reflect the disconnect rather than a server-side failure.
 *
 * The `x-clankermux-burst-retry: client-aborted` header predates the generic use
 * and is deliberately KEPT as-is: it is an existing diagnostic other code and
 * tests key on, and renaming it is a separate concern.
 *
 * This lives in its own dependency-free leaf module — NOT in the `handlers`
 * barrel — so both `proxy.ts` and `handlers/proxy-operations.ts` can import it
 * directly without an import cycle (`proxy-operations.ts` is itself re-exported
 * through that barrel).
 */
export function createClientAbortResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "client_closed_request",
				message: "Client disconnected before the request could be served.",
			},
		}),
		{
			status: 499,
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-burst-retry": "client-aborted",
			},
		},
	);
}
