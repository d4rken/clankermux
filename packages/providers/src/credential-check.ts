import { getDefaultEndpoint, PROVIDER_NAMES } from "@clankermux/types";
import { requestOpenRouterKey } from "./providers/openrouter/metadata";

export { GROK_MODELS_ENDPOINT } from "./providers/grok/provider";

export type CredentialCheckOutcome =
	| { status: "valid"; metadata?: unknown }
	/** Upstream said no. */
	| { status: "rejected"; detail: string }
	/** We could not get an answer. */
	| { status: "unverified"; detail: string }
	/** Nothing checkable for this account: proceed as if no check existed. */
	| { status: "skipped"; detail: string };

export interface CredentialCheckInput {
	apiKey: string;
	customEndpoint: string | null;
}

export interface CredentialCheck {
	/** Names what was probed, for the operator-facing refusal message. */
	readonly surface: string;
	/**
	 * A fixed operator-facing sentence appended to a `rejected` refusal, naming
	 * this provider's likely cause. Never upstream text.
	 */
	readonly rejectedHint?: string;
	/**
	 * Never throws. `signal` is the caller's (normally the inbound request's),
	 * so a disconnect ends the probe instead of running out the timeout.
	 */
	run(
		input: CredentialCheckInput,
		signal: AbortSignal,
	): Promise<CredentialCheckOutcome>;
}

export const CREDENTIAL_CHECK_TIMEOUT_MS = 5_000;

// Every `detail` below is a fixed phrase plus at most a status code. Upstream
// bodies, URLs and exception text never reach it: credentials get echoed.
function classifyStatus(status: number): CredentialCheckOutcome {
	if (status >= 200 && status < 300) return { status: "valid" };
	if (status === 401 || status === 403)
		return {
			status: "rejected",
			detail: `rejected the API key (HTTP ${status})`,
		};
	if (status === 404)
		return {
			status: "rejected",
			detail: "does not exist for this key at this endpoint (HTTP 404)",
		};
	if (status === 429)
		return {
			status: "unverified",
			detail: "rate-limited the check (HTTP 429)",
		};
	return { status: "unverified", detail: `answered HTTP ${status}` };
}

async function probe(
	callerSignal: AbortSignal,
	send: (
		signal: AbortSignal,
	) => Promise<{ status: number; metadata?: unknown }>,
): Promise<CredentialCheckOutcome> {
	const timeout = AbortSignal.timeout(CREDENTIAL_CHECK_TIMEOUT_MS);
	let answer: { status: number; metadata?: unknown };
	try {
		answer = await send(AbortSignal.any([callerSignal, timeout]));
	} catch {
		if (callerSignal.aborted)
			return { status: "unverified", detail: "the check was cancelled" };
		if (timeout.aborted)
			return {
				status: "unverified",
				detail: `did not answer within ${CREDENTIAL_CHECK_TIMEOUT_MS / 1000}s`,
			};
		return { status: "unverified", detail: "could not be reached" };
	}
	const outcome = classifyStatus(answer.status);
	return outcome.status === "valid" && answer.metadata != null
		? { ...outcome, metadata: answer.metadata }
		: outcome;
}

function isAnthropicHost(url: URL): boolean {
	return url.hostname.replace(/\.$/, "") === "api.anthropic.com";
}

/**
 * A GET with the key as a Bearer token; any 2xx means the key is accepted.
 * `url` is either fixed or derived from the account's custom endpoint.
 */
export function catalogueCheck(
	surface: string,
	url: string | ((customEndpoint: string | null) => URL),
	options?: { rejectedHint?: string },
): CredentialCheck {
	return {
		surface,
		...(options?.rejectedHint ? { rejectedHint: options.rejectedHint } : {}),
		async run({ apiKey, customEndpoint }, signal) {
			let target: URL;
			try {
				target = typeof url === "string" ? new URL(url) : url(customEndpoint);
			} catch {
				return { status: "unverified", detail: "endpoint is not a valid URL" };
			}
			// Tooling never dials Anthropic. An operator-chosen endpoint can still
			// resolve there, and that is no evidence against the key.
			if (isAnthropicHost(target))
				return {
					status: "skipped",
					detail: "endpoint is api.anthropic.com, which is never probed",
				};
			return probe(signal, async (composed) => {
				const response = await fetch(target.toString(), {
					headers: {
						Authorization: `Bearer ${apiKey}`,
						Accept: "application/json",
					},
					signal: composed,
					redirect: "error",
				});
				await response.body?.cancel();
				return { status: response.status };
			});
		},
	};
}

/**
 * The MiMo catalogue URL for a stored request base.
 *
 *   https://h/anthropic       -> https://h/v1/models
 *   https://h/anthropic/v1/   -> https://h/v1/models
 *   https://h                 -> https://h/v1/models
 *   https://h/dep/anthropic   -> https://h/dep/v1/models
 *   null                      -> <MiMo default region>/v1/models
 *
 * The base normally ends in `/anthropic`, where requests go, but the
 * catalogue is OpenAI-shaped and sits on the host root: on a live Token Plan
 * subscription `/anthropic/v1/models` 404s while `/v1/models` answers. So one
 * terminal `/v1`, then one terminal `/anthropic`, come off rather than being
 * extended. Any deployment prefix ahead of them survives.
 *
 * Only throws for a string that is not an absolute URL at all. It does not
 * judge the base's shape (query, credentials, scheme); callers that need that
 * guard apply it, so a shape problem never surfaces here as a bare Error.
 */
export function mimoCatalogueUrl(endpoint: string | null): URL {
	const url = new URL(endpoint || getDefaultEndpoint(PROVIDER_NAMES.MIMO));
	url.pathname = `${url.pathname
		.replace(/\/+$/, "")
		.replace(/\/v1$/, "")
		.replace(/\/anthropic$/, "")}/v1/models`;
	return url;
}

/**
 * OpenRouter's key endpoint doubles as the account's metadata read, so a
 * valid outcome carries the parsed metadata and the caller need not ask again.
 */
export const openRouterKeyCheck: CredentialCheck = {
	surface: "OpenRouter key endpoint",
	run: ({ apiKey }, signal) =>
		probe(signal, (composed) => requestOpenRouterKey(apiKey, composed)),
};
