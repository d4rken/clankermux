import { Logger } from "@clankermux/logger";
import { CODEX_VERSION } from "./provider";

const log = new Logger("CodexModelCatalog");

/**
 * The model catalog a ChatGPT-subscription Codex account is served.
 *
 * This is the endpoint the Codex CLI itself calls on startup. It is NOT
 * OpenAI's documented `api.openai.com/v1/models` listing: that one describes an
 * API-key organisation and 403s (`Missing scopes: api.model.read`) for a
 * subscription token. This one answers per subscription, and the payload is a
 * single-field envelope, `{"models": [...]}`, whose entries carry ~34 keys each
 * — display metadata, reasoning levels, context windows, and the model's own
 * `base_instructions` system prompt.
 *
 * Free: a GET that reads subscription metadata, the same class of call as
 * `GET /backend-api/wham/usage` in `usage-status.ts`. It must never start or
 * advance a quota window.
 *
 * The URL is a fixed constant and deliberately NOT parameterised by
 * `account.custom_endpoint`. A Codex account can be pointed at a different
 * backend, and this call carries a ChatGPT OAuth bearer: sending it to an
 * operator-configured host would hand that credential to whatever it names.
 *
 * Note for whoever merges `worktree-codex-model-catalog`: that branch declares
 * the same URL in `models-listing.ts` for a different purpose — it normalises
 * the payload down to a routing input (slug/context window/visibility). The two
 * constants should be deduplicated at that point; the consumers stay separate.
 */
export const CODEX_MODEL_CATALOG_URL =
	"https://chatgpt.com/backend-api/codex/models";

/**
 * Bounded so a slow or hanging backend cannot stall a Codex startup. Shorter
 * than the 15s used for background polls because a client is waiting on this
 * one; on timeout the caller serves a stale or static list instead.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export interface FetchCodexModelCatalogArgs {
	/** A valid ChatGPT OAuth access token for a Codex account. */
	accessToken: string;
	/** From the token's JWT claims; sent as `ChatGPT-Account-ID` when present. */
	chatgptAccountId: string | null;
	/**
	 * The requesting client's own version, forwarded verbatim.
	 *
	 * The catalog is version-gated — entries carry `minimal_client_version`, and
	 * OpenAI filters on this parameter — so forwarding the caller's version is
	 * what makes the reply the same catalog it would have received talking to
	 * OpenAI directly. Substituting our own {@link CODEX_VERSION} would hand a
	 * 0.149 client the narrower catalog a 0.144 client is served.
	 */
	clientVersion: string | null;
	fetchImpl?: typeof fetch;
}

export type CodexModelCatalogResult =
	| { ok: true; bodyText: string; etag: string | null }
	| { ok: false; status: number | null };

function buildHeaders(
	accessToken: string,
	chatgptAccountId: string | null,
	clientVersion: string | null,
): Headers {
	// Keep the whole request internally consistent: if we claim a client version
	// in the query string, the version-bearing headers claim the same one rather
	// than announcing 0.144 alongside a `client_version=0.149` parameter.
	const version = clientVersion ?? CODEX_VERSION;
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		Version: version,
		"User-Agent": `codex-cli/${version} (Windows 10.0.26100; x64)`,
		originator: "codex_cli_rs",
	});
	const accountId = chatgptAccountId?.trim();
	if (accountId) headers.set("ChatGPT-Account-ID", accountId);
	return headers;
}

/**
 * True when the body is the envelope Codex's deserializer expects.
 *
 * We check the shape but return the ORIGINAL text, never a re-serialisation.
 * Codex requires ~18 fields per entry and falls back to its built-in catalog
 * without surfacing a parse failure to the user, so a body we rebuilt and
 * quietly truncated would look exactly like success from here. The check exists
 * only to stop an HTML error page or a challenge interstitial being cached and
 * served as a catalog.
 */
function isModelsEnvelope(bodyText: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return false;
	}
	return Array.isArray((parsed as { models?: unknown }).models);
}

/**
 * Read a Codex account's model catalog. Zero quota cost.
 *
 * Fail-clean: any non-200, unexpected body, timeout, or network throw returns
 * `ok: false` rather than throwing, so a caller can fall back to a cached or
 * static answer. A failure here is a failure to LEARN something and must never
 * be counted as evidence about the account's health.
 */
export async function fetchCodexModelCatalog(
	args: FetchCodexModelCatalogArgs,
): Promise<CodexModelCatalogResult> {
	const {
		accessToken,
		chatgptAccountId,
		clientVersion,
		fetchImpl = fetch,
	} = args;

	if (!accessToken || accessToken.trim() === "") {
		throw new Error("fetchCodexModelCatalog requires a non-empty access token");
	}

	const url = new URL(CODEX_MODEL_CATALOG_URL);
	if (clientVersion) url.searchParams.set("client_version", clientVersion);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url.toString(), {
			method: "GET",
			signal: controller.signal,
			headers: buildHeaders(accessToken, chatgptAccountId, clientVersion),
		});

		if (!response.ok) {
			log.warn(
				`Model-catalog endpoint returned ${response.status} ${response.statusText}`,
			);
			return { ok: false, status: response.status };
		}

		const bodyText = await response.text();
		if (!isModelsEnvelope(bodyText)) {
			log.warn(
				"Model-catalog endpoint returned a body with no models array; ignoring it",
			);
			return { ok: false, status: response.status };
		}

		return {
			ok: true,
			bodyText,
			etag: response.headers.get("ETag"),
		};
	} catch (error) {
		log.warn(
			"Failed to fetch the Codex model catalog:",
			error instanceof Error ? error.message : String(error),
		);
		return { ok: false, status: null };
	} finally {
		clearTimeout(timeoutId);
	}
}
