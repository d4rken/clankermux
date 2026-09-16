import { Logger } from "@clankermux/logger";
import { CODEX_USER_AGENT, CODEX_VERSION } from "./provider";

const log = new Logger("CodexSubscription");

/**
 * The ChatGPT backend's subscription record for one workspace. Read-only
 * metadata: it costs no quota, starts no window, and changes nothing upstream.
 *
 * Deliberately the ONLY billing endpoint this codebase talks to. In
 * particular never `/backend-api/payments/customer_portal`, which returns a
 * live Stripe session URL capable of cancelling the subscription.
 */
export const CODEX_SUBSCRIPTION_ENDPOINT =
	"https://chatgpt.com/backend-api/subscriptions";

const REQUEST_TIMEOUT_MS = 5_000;

export interface FetchCodexSubscriptionArgs {
	/** A FRESH access token (the one the caller's last successful read used). */
	accessToken: string;
	/**
	 * Workspace UUID for the `account_id` query parameter, as
	 * `readChatgptAccountId` resolves it. MANDATORY: without it the endpoint
	 * answers HTTP 200 with a `{"detail": …}` body, so a missing id produces a
	 * "successful" response carrying no subscription at all.
	 */
	chatgptAccountId: string | null;
	/** Injected for testability. Defaults to global `fetch`. */
	fetchImpl?: typeof fetch;
}

/**
 * Result of one subscription read. Three outcomes, not two:
 *
 *   ok           — a reachable, parseable, positive answer.
 *   unsupported  — HTTP 404: the workspace has NO subscription record (observed
 *                  on education plans). A reachable negative answer, not an
 *                  error, and not worth retrying before the next throttle
 *                  window.
 *   neither      — transport failure, non-404 status, or a body that carries
 *                  no subscription. The caller must keep whatever it already
 *                  stored rather than overwrite it with nulls.
 */
export interface CodexSubscription {
	/** ms-epoch `active_start`. */
	activeStartMs: number | null;
	/** ms-epoch `active_until`: the END of the current period. */
	activeUntilMs: number | null;
	/** Raw `billing_period` as reported (e.g. "monthly", "annual"). */
	billingPeriod: string | null;
	/** `will_renew`; null when the field is absent or not a boolean. */
	willRenew: boolean | null;
	/** `is_delinquent`; null when absent. */
	isDelinquent: boolean | null;
	/** ms-epoch `grace_period_end_timestamp`. */
	graceEndsAtMs: number | null;
	/** ms-epoch `became_delinquent_timestamp`. */
	becameDelinquentAtMs: number | null;
	/** `plan_type` (e.g. "plus", "pro", "team"). */
	planType: string | null;
	ok: boolean;
	/** HTTP 404 — the workspace has no subscription record. */
	unsupported: boolean;
	/** HTTP status; null on a network throw. */
	status: number | null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: null;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

/**
 * Unix SECONDS → ms, parsed permissively. These fields arrive as numbers on a
 * healthy account but have been observed quoted as strings on a delinquent one
 * — the exact account where the grace-period fields matter most — so a strict
 * integer parse would blank the result precisely when it carries information.
 *
 *   1791367200 → 1791367200000 · "1791367200" → 1791367200000 · 0 → null
 */
function unixSecondsToMs(value: unknown): number | null {
	const seconds =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseFloat(value)
				: Number.NaN;
	if (!Number.isFinite(seconds) || seconds <= 0) return null;
	const ms = Math.trunc(seconds * 1_000);
	return Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

function failedSubscription(
	status: number | null,
	unsupported = false,
): CodexSubscription {
	return {
		activeStartMs: null,
		activeUntilMs: null,
		billingPeriod: null,
		willRenew: null,
		isDelinquent: null,
		graceEndsAtMs: null,
		becameDelinquentAtMs: null,
		planType: null,
		ok: false,
		unsupported,
		status,
	};
}

/**
 * Pure parser for a `/backend-api/subscriptions` body. Never throws.
 *
 * HTTP 200 is NOT the success signal. Calling the endpoint without
 * `account_id` answers 200 with a `{"detail": …}` body, so a payload carrying
 * neither `plan_type` nor `active_until` is a failure however healthy its
 * status line looks.
 */
export function parseCodexSubscription(
	body: unknown,
	status: number,
): CodexSubscription {
	const root = asRecord(body);
	if (!root) return failedSubscription(status);

	const planType = nullableString(root.plan_type);
	const activeUntilMs = unixSecondsToMs(root.active_until);
	if (planType === null && activeUntilMs === null) {
		return failedSubscription(status);
	}

	return {
		activeStartMs: unixSecondsToMs(root.active_start),
		activeUntilMs,
		billingPeriod: nullableString(root.billing_period),
		willRenew: nullableBoolean(root.will_renew),
		isDelinquent: nullableBoolean(root.is_delinquent),
		graceEndsAtMs: unixSecondsToMs(root.grace_period_end_timestamp),
		becameDelinquentAtMs: unixSecondsToMs(root.became_delinquent_timestamp),
		planType,
		ok: true,
		unsupported: false,
		status,
	};
}

/**
 * Reported `billing_period` → the renewal cadence the account row stores.
 * Anything unrecognised is null, which the anchor sync reads as "the provider
 * stated no period" rather than as a guess dressed up as a reading.
 */
export function renewalCadenceFromBillingPeriod(
	billingPeriod: string | null,
): "monthly" | "yearly" | null {
	switch (billingPeriod?.trim().toLowerCase()) {
		case "month":
		case "monthly":
			return "monthly";
		case "year":
		case "yearly":
		case "annual":
		case "annually":
			return "yearly";
		default:
			return null;
	}
}

/**
 * The Codex CLI's own identity, NOT browser-shaped headers: a comparison
 * project measured browser spoofing drawing a Cloudflare challenge on this
 * host where the CLI identity got a 200.
 */
function createSubscriptionHeaders(
	accessToken: string,
	chatgptAccountId: string,
): Headers {
	return new Headers({
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		Version: CODEX_VERSION,
		"User-Agent": CODEX_USER_AGENT,
		originator: "codex_cli_rs",
		"ChatGPT-Account-ID": chatgptAccountId,
	});
}

/**
 * Read one workspace's subscription record. Zero quota cost. Fail-clean: any
 * transport error, non-200 status or unusable body returns `ok: false` (never
 * throws), so the caller keeps whatever it already stored.
 */
export async function fetchCodexSubscription(
	args: FetchCodexSubscriptionArgs,
): Promise<CodexSubscription> {
	const { accessToken, chatgptAccountId, fetchImpl = fetch } = args;

	if (!accessToken || accessToken.trim() === "") {
		throw new Error("fetchCodexSubscription requires a non-empty access token");
	}
	const accountId = chatgptAccountId?.trim();
	if (!accountId) {
		// Issuing the GET anyway would return 200 with a detail body, i.e. a
		// negative answer wearing a success status.
		log.debug("Skipping subscription read: no ChatGPT account id on the token");
		return failedSubscription(null);
	}

	const url = `${CODEX_SUBSCRIPTION_ENDPOINT}?account_id=${encodeURIComponent(accountId)}`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			signal: controller.signal,
			headers: createSubscriptionHeaders(accessToken, accountId),
		});

		if (response.status === 404) {
			// A reachable "this workspace has no subscription record" (education
			// plans). Reported as its own outcome so the caller can store the
			// absence instead of retrying it.
			return failedSubscription(404, true);
		}
		if (!response.ok) {
			log.warn(
				`Subscription endpoint returned ${response.status} ${response.statusText}`,
			);
			return failedSubscription(response.status);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			log.warn("Subscription endpoint returned a non-JSON body");
			return failedSubscription(response.status);
		}

		return parseCodexSubscription(body, response.status);
	} catch (error) {
		log.warn(
			"Failed to fetch Codex subscription:",
			error instanceof Error ? error.message : String(error),
		);
		return failedSubscription(null);
	} finally {
		clearTimeout(timeoutId);
	}
}
