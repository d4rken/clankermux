import type { Account } from "@clankermux/types";
import { isOfficialAnthropicProvider } from "./provider-overload-cooldown";
import type { RequestBodyContext } from "./request-body-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Names the subscription account whose OAuth token carries the request in the
 * `account_uuid` of `metadata.user_id`, which Claude Code leaves empty when it
 * authenticates to ClankerMux with a token:
 *
 *   {"device_id":"e01c…","account_uuid":"","session_id":"8644…"}
 *   {"device_id":"e01c…","account_uuid":"<routed account>","session_id":"8644…"}
 *
 * A non-empty uuid is the client's own login and stays as sent.
 */
export function bindAnthropicAccountUuid(
	context: RequestBodyContext,
	account: Account,
): void {
	if (
		!isOfficialAnthropicProvider(account.provider) ||
		account.api_key ||
		account.custom_endpoint
	)
		return;
	const uuid = account.identity_external_id;
	if (!uuid || !UUID.test(uuid)) return;

	const metadata = context.getParsedJson()?.metadata;
	if (typeof metadata !== "object" || metadata === null) return;
	const userId = (metadata as Record<string, unknown>).user_id;
	if (typeof userId !== "string" || !userId.startsWith("{")) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return;
	const fields = parsed as Record<string, unknown>;
	if (fields.account_uuid !== "") return;

	fields.account_uuid = uuid;
	// Replace, never mutate: failover attempts share nested objects with the
	// base context (pinned by "gives each failover attempt its own account
	// without leaking into the parent" in anthropic-account-uuid.test.ts).
	context.mutateParsedJson((body) => {
		body.metadata = { ...metadata, user_id: JSON.stringify(fields) };
	});
}
