/** The exact command that protects the deployment. */
export const SET_PASSWORD_COMMAND = "bun run auth:password --set";

/**
 * Persistent notice while no management password is configured.
 *
 * INFORMATIONAL ONLY, and there is deliberately no button here. While the
 * deployment is fail-open, an HTTP password setter would let whichever LAN
 * caller reaches it first win the race and lock the operator out of their own
 * box — so the only way to set it is on the machine that owns the database, and
 * the most this banner can honestly do is show the command.
 *
 * Not dismissible either: it describes a standing condition, not an event, and
 * a dismissed banner would leave the deployment unprotected and unmentioned.
 */
export function UnprotectedApiBanner() {
	return (
		<div
			role="status"
			className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm"
		>
			<span className="font-medium">The management API is unprotected.</span>{" "}
			<span className="text-muted-foreground">
				Anyone who can reach this port can read and change every account. Set a
				password on the server with{" "}
			</span>
			<code className="font-mono select-all">{SET_PASSWORD_COMMAND}</code>
			<span className="text-muted-foreground">.</span>
		</div>
	);
}
