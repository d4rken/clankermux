/**
 * Anthropic endpoints that are bound to ONE OAuth identity, and the deliberate
 * refusal we answer them with.
 *
 * `/api/oauth/files/…` and `/api/oauth/file_upload` carry attachments, which
 * belong to the account that uploaded them. `/v1/code/…` is the Remote Control
 * surface, bound to the claude.ai session the client paired with — it even
 * carries its own token refresh (`/v1/code/auth/refresh`) separate from
 * `/v1/oauth/token`, because it does not use the API credential at all.
 *
 * A multiplexing proxy cannot serve any of them. Substituting a pooled account
 * token would make Anthropic observe account A's credential reading account B's
 * file or opening account B's Remote Control stream — a cross-account access
 * pattern an unmodified CLI never produces, and the one thing most likely to
 * read as credential abuse rather than as ordinary CLI traffic. Relaying the
 * client's own credential instead is not an option either: the proxy's clients
 * authenticate with a ClankerMux API key, so there is no upstream-valid
 * credential to pass through.
 *
 * So we refuse, and we refuse VISIBLY. Before this module these paths died on
 * whatever the router happened to do with them — a generic `Unknown API route`
 * 404 for the `/api/*` pair, and for `/v1/code/*` nothing at all, since it
 * satisfies `isProxyPath` and `AnthropicProvider.canHandle` accepts every path,
 * so it would have reached account selection and gone upstream on a rotated
 * token. An incidental 404 and an unexercised code path are not a policy.
 *
 * This lives in its own dependency-free leaf module — NOT in the `handlers`
 * barrel — so `apps/server`'s router and the proxy's own ingest prologue can
 * both import it without an import cycle. Mirrors
 * `handlers/client-abort-response.ts`.
 */

/**
 * Namespace roots that are identity-bound. Each matches the root itself and
 * everything beneath it — `/v1/code` and `/v1/code/sessions` alike — but never a
 * same-stem neighbour: `/v1/codex/responses` is a different namespace and must
 * keep working.
 */
export const IDENTITY_BOUND_PATH_PREFIXES: readonly string[] = [
	"/api/oauth/files",
	"/v1/code",
];

/**
 * Identity-bound paths that have no sub-path and so are matched exactly rather
 * than as a namespace root.
 */
const IDENTITY_BOUND_EXACT_PATHS: readonly string[] = [
	"/api/oauth/file_upload",
];

/** Decoding rounds allowed before giving up. Bounded so a `%25`-chain cannot
 *  spin: each round must shorten the string, so four is far past any real path. */
const MAX_DECODE_ROUNDS = 4;

function matchesLiterally(pathname: string): boolean {
	if (IDENTITY_BOUND_EXACT_PATHS.includes(pathname)) return true;
	return IDENTITY_BOUND_PATH_PREFIXES.some(
		(root) => pathname === root || pathname.startsWith(`${root}/`),
	);
}

/**
 * The most permissive reading of a path: what it would mean to a peer that
 * decodes escapes, treats `\` as a separator, collapses repeated slashes, and
 * resolves dot-segments. We match against this as well as the raw form because
 * the guarantee here is about what WE send, and every one of those
 * normalizations is something some hop between us and Anthropic might perform.
 *
 * Returns the raw pathname unchanged when nothing needed rewriting.
 */
function canonicalize(pathname: string): string {
	let decoded = pathname;
	for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
		if (!decoded.includes("%")) break;
		let next: string;
		try {
			next = decodeURIComponent(decoded);
		} catch {
			// Malformed escapes: stop here and canonicalize what we have. The
			// partially-decoded reading is still worth checking.
			break;
		}
		if (next === decoded) break;
		decoded = next;
	}

	const separated = decoded.replace(/\\/g, "/");
	const segments: string[] = [];
	for (const segment of separated.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

/**
 * Is `pathname` an endpoint bound to a single Anthropic OAuth identity?
 *
 * Checked against both the raw pathname and its canonical form. `URL`
 * resolves dot-segments but leaves escapes intact, so `/v1/%63ode/sessions`,
 * `/v1/code%2Fsessions`, `/v1/%2563ode/sessions` and `/v1//code/sessions` all
 * arrive looking like ordinary `/v1/…` proxy paths. Whether anything between
 * us and Anthropic would decode or normalize them is not ours to assume — the
 * guarantee this function provides is that WE never send a pooled credential to
 * one of these endpoints, so every reading that could resolve to one is
 * refused.
 *
 * Deliberately over-refuses rather than under-refuses: a path that only *looks*
 * like one of these under some normalization is rejected, which costs a caller
 * an odd 501 on a path it had no business encoding that way.
 */
export function isIdentityBoundPath(pathname: string): boolean {
	if (matchesLiterally(pathname)) return true;
	const canonical = canonicalize(pathname);
	return canonical !== pathname && matchesLiterally(canonical);
}

/**
 * The refusal. 501 because the proxy genuinely does not implement these
 * endpoints, and because the two obvious alternatives are both wrong: 403 is
 * the status Claude Code reads as a dead session, answering it with a re-login
 * prompt over what is really a proxy policy; 404 is indistinguishable from a
 * URL that simply was not routed, which is the accident this replaces.
 *
 * The `x-clankermux-refusal` header follows the existing
 * `x-clankermux-pool-status` convention so the reason is machine-readable
 * without parsing prose.
 */
export function createIdentityBoundRefusalResponse(pathname: string): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "proxy_error",
				message:
					`${pathname} is bound to a single Anthropic account and cannot be ` +
					"served by ClankerMux: answering it would require sending one " +
					"account's credential for another account's data. Point the client " +
					"directly at api.anthropic.com for this endpoint.",
			},
		}),
		{
			status: 501,
			headers: {
				"Content-Type": "application/json",
				"x-clankermux-refusal": "identity-bound-endpoint",
			},
		},
	);
}
