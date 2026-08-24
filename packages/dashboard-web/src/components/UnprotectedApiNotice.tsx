import { ShieldAlert } from "lucide-react";

/** The exact command that protects the deployment. */
export const SET_PASSWORD_COMMAND = "bun run auth:password --set";

/**
 * Persistent notice while no management password is configured.
 *
 * INFORMATIONAL ONLY, and there is deliberately no button here. While the
 * deployment is fail-open, an HTTP password setter would let whichever LAN
 * caller reaches it first win the race and lock the operator out of their own
 * box — so the only way to set it is on the machine that owns the database, and
 * the most this notice can honestly do is show the command.
 *
 * Not dismissible either: it describes a standing condition, not an event, and
 * a dismissed notice would leave the deployment unprotected and unmentioned.
 *
 * Lives in the navigation sidebar's footer rather than across the top of every
 * page. The condition is permanent in the default configuration, so a
 * full-width bar pushed every page's content down indefinitely for something
 * that is a standing property of the deployment, not news.
 *
 * Sized for that column: the sidebar is 192px wide and the footer adds `p-4`,
 * leaving ~160px. The command therefore wraps instead of overflowing, and keeps
 * `select-all` plus the monospace treatment because copying it is the entire
 * point of the box.
 */
export function UnprotectedApiNotice() {
	return (
		<div
			role="status"
			className="rounded-lg border border-destructive/30 bg-destructive/10 p-3"
		>
			<div className="flex items-start gap-item text-sm font-medium text-destructive-strong">
				<ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
				<span>Management API unprotected</span>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				Anyone who can reach this port can read and change every account. Set a
				password on the server:
			</p>
			<code className="mt-1.5 block select-all break-words rounded bg-background/60 px-1.5 py-1 font-mono text-[11px] leading-snug">
				{SET_PASSWORD_COMMAND}
			</code>
		</div>
	);
}
