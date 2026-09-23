import { createHash } from "node:crypto";

export function hashRoutingAffinityKey(
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	return createHash("sha256").update(value).digest("hex");
}
