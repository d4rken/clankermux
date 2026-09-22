/**
 * The credential-scoped client API at `/client/v1/*`.
 *
 * A machine client already holds one credential for this proxy — the client key
 * it sends its AI traffic with — and this namespace lets it read back the token
 * accounting of its own requests with that same key.
 *
 * A TOP-LEVEL SIBLING of `/wire/*` and `/public/*`, deliberately not a route
 * under `/api/*`. The management session gate is a path-prefix decision, so a
 * surface that lives under `/api/*` and is reachable with a client key can only
 * stay reachable by an exemption inside
 * `packages/http-api/src/services/management-auth-policy.ts` — which would make
 * that exemption set the only thing standing between a client key and the whole
 * management surface. A sibling mount is unreachable from the gate by
 * construction. `/public/v1/*` exists for the mirror-image reason (no
 * credential at all) and says so in its own comments.
 *
 * A leaf module with no imports, so the router and its tests can both use it
 * without dragging in server.ts. Mirrors `wire-mounts.ts`.
 */

/** The namespace this module owns in its entirety. */
export const CLIENT_API_NAMESPACE_ROOT = "/client";

/**
 * Is `pathname` inside the client API namespace?
 *
 * LITERAL and SEGMENT-BOUNDED, for the reasons `wire-mounts.ts` sets out at
 * length. Segment-bounded, because a predicate that swept in `/clientevil`
 * would push an unclassified path into a pipeline whose every downstream
 * predicate matches exactly — none of them would report the surprise, they
 * would simply stop matching. Literal, because a decoded match
 * (`/%63lient/v1/…`) would create a second spelling of the mount that only this
 * function understands; that spelling falls through to the root flow, which has
 * its own answer for it.
 *
 * Everything under the root is claimed, not just the routes that exist: the
 * namespace is ours, so an unknown path here has to fail visibly with the
 * namespace 404 instead of collecting the dashboard's index.html.
 */
export function isClientApiPath(pathname: string): boolean {
	return (
		pathname === CLIENT_API_NAMESPACE_ROOT ||
		pathname.startsWith(`${CLIENT_API_NAMESPACE_ROOT}/`)
	);
}
