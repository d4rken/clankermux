import { RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";
import { commitRelationshipLabel, version } from "../lib/version";
import { CopyButton } from "./CopyButton";

// ClankerMux is build-from-source + systemd only, so "updating" means pulling
// main and rebuilding — there is no npm/bun/binary install to detect.
export const UPDATE_COMMAND =
	"git pull --ff-only && bun run build && sudo systemctl restart clankermux";

// The checkout IS the deployment: work that lands without a restart is live in
// the tree but not in the running process, and only a restart adopts it.
export const RESTART_COMMAND = "sudo systemctl restart clankermux";

export type UpdateCheckStatus =
	| "idle"
	| "checking"
	| "available"
	| "current"
	| "unknown"
	| "error";

export interface UpdateInfo {
	currentSha: string | null;
	latestSha: string;
	latestUrl: string | null;
	dirty: boolean;
	behindBy: number | null;
	aheadBy: number | null;
	repo: string | null;
	/** Short sha the running process booted on; null when it wasn't captured. */
	bootSha: string | null;
	/** True when the checkout's HEAD moved away from `bootSha`. */
	restartPending: boolean;
	/** Why the GitHub lookup failed, when it did but the local answer stands. */
	remoteError: string | null;
}

export interface UpdateStatusPanelProps {
	status: UpdateCheckStatus;
	info: UpdateInfo | null;
	/** Transport-level failure of the check itself (status === "error"). */
	error: string | null;
	onCheck: () => void;
}

function behindLabel(behindBy: number): string {
	return `${behindBy} commit${behindBy === 1 ? "" : "s"} behind`;
}

/**
 * The sidebar's deployment-status widget.
 *
 * It reports two ORTHOGONAL things and must not conflate them:
 *  - repo freshness — does main have commits this checkout lacks?
 *  - process freshness — is the running process on the commit the checkout is
 *    at? Merging into main without restarting moves HEAD under a live process,
 *    which reads as "up to date" while the old code still serves traffic.
 *
 * A pending restart wins the headline whenever both are true: a restart is
 * actionable right now, an available update is a longer errand. The update is
 * kept as secondary detail rather than dropped.
 *
 * Note the restart signal is exactly "checkout HEAD changed since boot". It
 * does NOT see tracked files edited in place without moving HEAD, so nothing
 * here may be worded as if it did.
 */
export function UpdateStatusPanel({
	status,
	info,
	error,
	onCheck,
}: UpdateStatusPanelProps) {
	const restartPending = info?.restartPending === true;
	const showUpdateDetail = status === "available";
	const showCurrentDetail = status === "current" && !restartPending;

	return (
		<div
			className={cn(
				"rounded-lg bg-muted/50 p-3",
				status === "checking" && "opacity-50",
			)}
		>
			<button
				type="button"
				onClick={onCheck}
				disabled={status === "checking"}
				className="w-full transition-colors hover:bg-muted/50 -m-3 p-3 rounded-lg"
			>
				<div className="flex items-center gap-2 text-sm">
					<RefreshCw
						className={cn(
							"h-4 w-4",
							status === "checking" && "animate-spin",
							restartPending && "text-warning-strong",
							!restartPending &&
								status === "available" &&
								"text-success-strong",
							!restartPending && status === "current" && "text-primary",
							!restartPending &&
								status === "unknown" &&
								"text-muted-foreground",
							status === "error" && "text-destructive-strong",
						)}
					/>
					<span className="font-medium">
						{status === "checking"
							? "Checking..."
							: restartPending
								? "Restart Pending"
								: status === "idle"
									? "Check for Updates"
									: status === "available"
										? "Update Available"
										: status === "current"
											? "Up to Date"
											: status === "unknown"
												? "Status Unknown"
												: "Check Failed"}
					</span>
				</div>
			</button>

			{restartPending && (
				<div className="mt-2 space-y-1">
					<p className="text-xs text-muted-foreground text-left font-mono">
						{info?.bootSha ?? "?"} → {info?.currentSha ?? "?"}
					</p>
					<p className="text-xs text-muted-foreground text-left">
						The checkout's HEAD moved after this process started; it is still
						running the commit on the left. Restart to run the checked-out one.
					</p>
					<div className="flex items-center gap-1">
						<code className="text-xs bg-background px-1 py-0.5 rounded font-mono flex-1 truncate">
							{RESTART_COMMAND}
						</code>
						<CopyButton
							value={RESTART_COMMAND}
							size="sm"
							variant="ghost"
							className="h-6 w-6 p-0"
							title="Copy restart command"
						/>
					</div>
				</div>
			)}

			{showUpdateDetail && (
				<div className="mt-2 space-y-1">
					{restartPending && (
						<p className="text-xs text-muted-foreground text-left">
							An update is also available:
						</p>
					)}
					<p className="text-xs text-muted-foreground text-left font-mono">
						{info?.currentSha ?? "?"} → {info?.latestSha}
					</p>
					{typeof info?.behindBy === "number" && info.behindBy > 0 && (
						<p className="text-xs text-muted-foreground text-left">
							{behindLabel(info.behindBy)}
						</p>
					)}
					<div className="flex items-center gap-1">
						<code className="text-xs bg-background px-1 py-0.5 rounded font-mono flex-1 truncate">
							{UPDATE_COMMAND}
						</code>
						<CopyButton
							value={UPDATE_COMMAND}
							size="sm"
							variant="ghost"
							className="h-6 w-6 p-0"
							title="Copy update command"
						/>
					</div>
					{info?.latestUrl && (
						<a
							href={info.latestUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="text-xs text-muted-foreground hover:text-foreground underline text-left block"
						>
							View latest commit
						</a>
					)}
				</div>
			)}

			{showCurrentDetail && (
				<div className="mt-1 space-y-0.5 text-left">
					<p className="text-xs text-muted-foreground font-mono">
						{info?.currentSha ?? version.replace(/^v/, "")}
					</p>
					<p className="text-xs text-muted-foreground">
						{commitRelationshipLabel(
							info?.aheadBy ?? null,
							info?.behindBy ?? null,
						)}
					</p>
					{info?.dirty && (
						<p className="text-xs italic text-muted-foreground/70">
							local uncommitted changes
						</p>
					)}
				</div>
			)}

			{status === "unknown" && (
				<p className="mt-1 text-xs text-muted-foreground text-left break-words">
					{info?.remoteError
						? `Could not reach GitHub: ${info.remoteError}`
						: "Could not determine the deployed commit (not a git checkout?)."}
				</p>
			)}

			{status === "error" && error && (
				<p className="mt-1 text-xs text-destructive-strong text-left break-words">
					{error}
				</p>
			)}
		</div>
	);
}
