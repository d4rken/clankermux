import { Logger } from "@clankermux/logger";
import type { Account, RequestMeta } from "@clankermux/types";
import type { RequestBodyContext } from "./request-body-context";

const log = new Logger("Proxy");

const FIELD = "fallback_credit_token";

function strippedBecause(
	value: unknown,
	account: Account,
	issuer: RequestMeta["fallbackCreditIssuer"],
): string | null {
	if (typeof value !== "string" || value.length === 0) return "malformed field";
	if (!issuer?.accountId) return "unknown issuer";
	if (issuer.accountId !== account.id) return "other account";
	if (
		(account.identity_external_id ?? null) !==
		(issuer.identityExternalId ?? null)
	)
		return "identity changed";
	return null;
}

/**
 * Keeps a refused turn's `fallback_credit_token` only on the attempt that goes
 * to the account, under the same identity, whose refusal issued it; every
 * other attempt sends the body without the field:
 *
 *   issuer acc-a/org-a, attempt on acc-a/org-a  {"model":…,"fallback_credit_token":"fbc…"}
 *   issuer acc-a/org-a, attempt on acc-b        {"model":…}
 *
 * A body without the field is left as sent.
 */
export function bindFallbackCredit(
	context: RequestBodyContext,
	account: Account,
	issuer: RequestMeta["fallbackCreditIssuer"],
	requestId: string,
): void {
	const body = context.getParsedJson();
	if (!body || !Object.hasOwn(body, FIELD)) return;
	const reason = strippedBecause(body[FIELD], account, issuer);
	if (!reason) return;

	// Only the attempt's own top-level object loses the key: a failover
	// attempt's context is a shallow copy of the base context (pinned by
	// "strips per attempt without touching the parent or another attempt" in
	// fallback-credit-binding.test.ts).
	context.mutateParsedJson((parsed) => {
		delete parsed[FIELD];
	});
	log.debug(
		`Removed ${FIELD} from request ${requestId} for account ${account.name}: ${reason}`,
	);
}
