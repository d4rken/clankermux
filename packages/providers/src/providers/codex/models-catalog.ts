import { Logger } from "@clankermux/logger";
import { CODEX_USER_AGENT, CODEX_VERSION } from "./provider";

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
 * The catalog is fetched as OUR pinned {@link CODEX_VERSION}, never as the
 * requesting client's version, even though the client sends one.
 *
 * The catalog is version-gated: entries carry `minimal_client_version` and
 * OpenAI filters on the `client_version` parameter. Every inference request
 * this proxy makes is stamped with the pinned `CODEX_VERSION`
 * (`provider.ts` → `Version` / `User-Agent`), so asking as a NEWER client
 * would return models we then cannot use: Codex would list one, send it, and
 * the backend would reject it as requiring a newer client — the failure mode
 * already recorded for this repo's version gate.
 *
 * A catalog fetched at the version we actually speak is therefore the correct
 * answer, not a degraded one. It is narrower than a newer client would receive
 * talking to OpenAI directly, and that narrowness is the point: it describes
 * what this proxy can serve. Raising it is one edit — bump `CODEX_VERSION` —
 * and that bump moves catalog and inference together, which is the invariant.
 */

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
	fetchImpl?: typeof fetch;
}

export type CodexModelCatalogResult =
	| { ok: true; bodyText: string; etag: string | null }
	| { ok: false; status: number | null };

function buildHeaders(
	accessToken: string,
	chatgptAccountId: string | null,
): Headers {
	const headers = new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		Version: CODEX_VERSION,
		"User-Agent": CODEX_USER_AGENT,
		originator: "codex_cli_rs",
	});
	const accountId = chatgptAccountId?.trim();
	if (accountId) headers.set("ChatGPT-Account-ID", accountId);
	return headers;
}

/**
 * True when the body is the envelope Codex's deserializer expects.
 *
 * We INSPECT the shape but return the ORIGINAL text, never a re-serialisation.
 * Codex requires ~18 fields per entry and falls back to its built-in catalog
 * without surfacing a parse failure to the user, so a body we rebuilt and
 * quietly truncated would look exactly like success from here. Reading fields
 * without rebuilding the body cannot drop the ones we do not know about.
 *
 * Entries are checked individually, not just the array: `{"models":[null]}` and
 * `{"models":["gpt-5"]}` are both arrays, and accepting either would cache an
 * undeserializable body for hours — recreating precisely the silent failure
 * this module exists to end. `slug` is the one field every consumer needs, so
 * it stands in as the discriminator; everything beyond it is deliberately not
 * our business.
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
	const models = (parsed as { models?: unknown }).models;
	if (!Array.isArray(models)) return false;
	return models.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			!Array.isArray(entry) &&
			typeof (entry as { slug?: unknown }).slug === "string" &&
			(entry as { slug: string }).slug.length > 0,
	);
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
	const { accessToken, chatgptAccountId, fetchImpl = fetch } = args;

	if (!accessToken || accessToken.trim() === "") {
		throw new Error("fetchCodexModelCatalog requires a non-empty access token");
	}

	const url = new URL(CODEX_MODEL_CATALOG_URL);
	url.searchParams.set("client_version", CODEX_VERSION);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url.toString(), {
			method: "GET",
			signal: controller.signal,
			// A cross-origin redirect would strip Authorization per the fetch spec,
			// but say so structurally rather than relying on that: this bearer has
			// exactly one valid destination.
			redirect: "error",
			headers: buildHeaders(accessToken, chatgptAccountId),
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
