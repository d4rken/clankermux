import type { Role } from "@clankermux/types";

/**
 * The background a message takes for its role.
 *
 * `Message` kept this as `ROLE_STYLES` and `MessageBubble` as
 * `ROLE_BG_COLORS`, with byte-identical strings in both — so the avatar disc
 * and the bubble beside it could drift apart silently, which is exactly the
 * kind of split a single conversation row makes obvious and a code review does
 * not. `Message` keeps its own icon map, since only it draws an avatar.
 */
export const ROLE_BACKGROUNDS: Record<Role, string> = {
	user: "bg-primary text-primary-foreground",
	assistant: "bg-muted",
	system: "bg-warning/15 text-foreground",
};
