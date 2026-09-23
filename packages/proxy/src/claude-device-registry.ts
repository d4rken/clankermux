import { isClaudeCliUserAgent } from "@clankermux/core";
import type { RequestJsonBody } from "./request-body-context";

const DEVICE_ID = /^[0-9a-f]{64}$/;
// A real user_id is 186 characters; anything far longer is not one.
const USER_ID_MAX_LENGTH = 512;

/**
 * The `device_id` an interactive Claude Code request names in its
 * `metadata.user_id`, a JSON string such as
 * `{"device_id":"e01c…(64 hex)","account_uuid":"","session_id":"8644…"}`.
 * Null for any other client and for anything malformed.
 */
export function extractClaudeCliDeviceId(
	headers: Headers,
	body: RequestJsonBody | null,
): string | null {
	if (!isClaudeCliUserAgent(headers.get("user-agent"))) return null;
	const metadata = body?.metadata;
	if (typeof metadata !== "object" || metadata === null) return null;
	const userId = (metadata as { user_id?: unknown }).user_id;
	if (
		typeof userId !== "string" ||
		!userId.startsWith("{") ||
		userId.length > USER_ID_MAX_LENGTH
	)
		return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const deviceId = (parsed as { device_id?: unknown }).device_id;
	return typeof deviceId === "string" && DEVICE_ID.test(deviceId)
		? deviceId
		: null;
}

/**
 * The Claude Code device most recently served successfully by each account,
 * which that account's keepalive names as its own. In memory only.
 */
export class ClaudeDeviceRegistry {
	private readonly devices = new Map<string, string>();

	record(accountId: string, deviceId: string): void {
		this.devices.set(accountId, deviceId);
	}

	deviceIdFor(accountId: string): string | null {
		return this.devices.get(accountId) ?? null;
	}

	reset(): void {
		this.devices.clear();
	}
}
