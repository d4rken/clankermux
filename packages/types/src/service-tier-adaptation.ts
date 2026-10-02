import { decodeAuditRecord, encodeAuditRecord } from "./attempt-audit-codec";

/**
 * What one dispatch did to the request's `service_tier`, carried from the
 * provider that serialized the upstream body to the attempt row that records
 * it.
 *
 * - `requested` — the client's tier, where the path still has the client's
 *   body (native Responses passthrough). NULL means none was sent OR that the
 *   path does not carry it (the translated path builds a fresh body).
 * - `sent` — the tier serialized for this attempt. Serialized, not honoured:
 *   the ChatGPT backend reports `service_tier: "default"` on the completed
 *   response even when it served `priority`, so no upstream echo confirms it.
 * - `reason` — why the proxy set it, NULL when it passed through untouched.
 *   Recorded even when the client already asked for the same tier, so the row
 *   shows the policy ran.
 */
export interface ServiceTierAdaptation {
	readonly requested: string | null;
	readonly sent: string | null;
	readonly reason: string | null;
}

/** The account's fast-mode policy set the tier. */
export const SERVICE_TIER_ACCOUNT_FAST_MODE = "account_fast_mode";

/** The tier fast mode sends. */
export const FAST_MODE_SERVICE_TIER = "priority";

/**
 * Per-attempt channel from `transformRequestBody` to the attempt row. An
 * ordinary inbound header name, so every inbound path must strip it before the
 * transform; sdk-bridge-floor.test.ts and service-tier-adaptation.test.ts pin
 * the bridge, direct and forced paths.
 */
export const SERVICE_TIER_ADAPTATION_HEADER = "x-clankermux-service-tier";

const KEYS = ["requested", "sent", "reason"] as const;

export function encodeServiceTierAdaptation(
	adaptation: ServiceTierAdaptation,
): string | null {
	return encodeAuditRecord(KEYS, adaptation);
}

export function decodeServiceTierAdaptation(
	value: string | null | undefined,
): ServiceTierAdaptation | null {
	return decodeAuditRecord(KEYS, value);
}

export function readServiceTierAdaptation(
	headers: Headers,
): ServiceTierAdaptation | null {
	return decodeServiceTierAdaptation(
		headers.get(SERVICE_TIER_ADAPTATION_HEADER),
	);
}

/**
 * Set the header, or remove it when there is nothing to record. Always one or
 * the other, so a forged inbound value can never survive onto the attempt row.
 */
export function applyServiceTierAdaptation(
	headers: Headers,
	adaptation: ServiceTierAdaptation | null,
): void {
	const encoded = adaptation ? encodeServiceTierAdaptation(adaptation) : null;
	if (encoded === null) headers.delete(SERVICE_TIER_ADAPTATION_HEADER);
	else headers.set(SERVICE_TIER_ADAPTATION_HEADER, encoded);
}
