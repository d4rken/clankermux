import {
	AlertCircle,
	AlertTriangle,
	CheckCircle,
	Loader2,
	RefreshCw,
	XCircle,
} from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { useStorageInfo, useTriggerIntegrityCheck } from "../../hooks/queries";
import { staleAgeLabel } from "../../lib/data-availability";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

function formatRelative(iso: string | null): string {
	if (!iso) return "never";
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return "—";
	const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (deltaSec < 60) return `${deltaSec}s ago`;
	if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
	if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
	return `${Math.floor(deltaSec / 86400)}d ago`;
}

/**
 * Storage-integrity status block (status panel, last-check timestamps, manual
 * check buttons) without a surrounding Card, so the caller supplies its own
 * framing — the System Health page wraps it in one. The corruption banner lives
 * in {@link StorageIntegrityBanner}.
 */
export function StorageIntegritySection() {
	const { data, isLoading, error } = useStorageInfo();
	const triggerCheck = useTriggerIntegrityCheck();
	const [lastTriggeredKind, setLastTriggeredKind] = useState<
		"quick" | "full" | null
	>(null);

	const status = data?.integrity_status ?? "unchecked";
	// Drive the spinner off the in-flight kind, NOT the collapsed status: the
	// backend no longer overwrites `status` with "running", so a `corrupt`
	// status (and its banner) persists while a recheck runs.
	const isRunning =
		data?.integrity_running_kind != null || triggerCheck.isPending;
	const runningKind = data?.integrity_running_kind ?? lastTriggeredKind;

	const onClick = (kind: "quick" | "full") => {
		setLastTriggeredKind(kind);
		triggerCheck.mutate(kind);
	};

	let badgeNode: ReactElement;
	let icon: ReactElement;
	let label: string;
	let description: string;
	let tone: "ok" | "warn" | "danger" | "neutral";

	if (isRunning) {
		tone = "neutral";
		icon = <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
		label = `Running ${runningKind ?? ""} integrity check`;
		description = "This may take a while on large databases.";
		badgeNode = <Badge variant="secondary">Running</Badge>;
	} else if (status === "corrupt") {
		tone = "danger";
		icon = <XCircle className="h-5 w-5 text-destructive-strong" />;
		label = "Database corruption detected";
		description = data?.last_integrity_error ?? "See server logs for details.";
		badgeNode = <Badge variant="destructive">Corrupt</Badge>;
	} else if (status === "skipped") {
		// A check could not complete (worker timeout / error / defensive
		// size-skip). This is NOT proven corruption — surface it amber and
		// reassure with the last VERIFIED verdict, so a slow full check on a
		// huge DB never lights the red corruption UI.
		tone = "warn";
		icon = <AlertTriangle className="h-5 w-5 text-warning-strong" />;
		const skipReason =
			data?.last_full_skip_reason ?? data?.last_quick_skip_reason ?? null;
		const lastVerified =
			data?.last_full_result === "ok" && data?.last_full_check_at != null
				? `Last full check ${formatRelative(data.last_full_check_at)} passed`
				: data?.last_quick_result === "ok" && data?.last_quick_check_at != null
					? `Last quick check ${formatRelative(data.last_quick_check_at)} passed`
					: "No prior verified check on record";
		// Headline the kind that actually skipped — a standalone quick skip
		// (quick tick timed out, or a manual "Run quick check" errored) also
		// lands here with last_full_skip_reason === null.
		label = data?.last_full_skip_reason
			? "Full integrity check couldn't complete"
			: data?.last_quick_skip_reason
				? "Quick integrity check couldn't complete"
				: "Integrity check couldn't complete";
		description = `${skipReason ?? "The integrity check could not complete."} · ${lastVerified}`;
		badgeNode = <Badge variant="secondary">Skipped</Badge>;
	} else if (status === "ok") {
		tone = "ok";
		icon = <CheckCircle className="h-5 w-5 text-success-strong" />;
		label = "Database integrity verified";
		description =
			data?.last_full_check_at != null
				? `Last full check ${formatRelative(data.last_full_check_at)}`
				: data?.last_quick_check_at != null
					? `Last quick check ${formatRelative(data.last_quick_check_at)} — full check still pending`
					: "—";
		// The badge's own success variant rather than `variant="default"` with a
		// `bg-success` override, which kept the default variant's white text and
		// only swapped the background — white on green fails contrast either way.
		badgeNode = <Badge variant="success">Healthy</Badge>;
	} else {
		tone = "warn";
		icon = <AlertTriangle className="h-5 w-5 text-warning-strong" />;
		label = "Integrity not yet verified";
		description =
			"Scheduler runs the first quick check 30 s after startup and a full check 30 min after startup.";
		badgeNode = <Badge variant="secondary">Unchecked</Badge>;
	}

	const tonePanel =
		tone === "ok"
			? "bg-success/10"
			: tone === "danger"
				? "bg-destructive/10"
				: tone === "warn"
					? "bg-warning/10"
					: "bg-muted/50";

	return isLoading ? (
		<div className="text-sm text-muted-foreground">Loading…</div>
	) : error ? (
		<div className="text-sm text-destructive-strong">
			Failed to load storage status.
		</div>
	) : (
		<div className="space-y-4">
			<div
				className={`flex items-center justify-between p-4 rounded-lg ${tonePanel}`}
			>
				<div className="flex items-center gap-3">
					{icon}
					<div>
						<p className="font-medium">{label}</p>
						<p className="text-sm text-muted-foreground">{description}</p>
					</div>
				</div>
				{badgeNode}
			</div>

			<dl className="grid grid-cols-2 gap-3 text-sm">
				<div>
					<dt className="text-muted-foreground">Last quick check</dt>
					<dd>
						{data?.last_quick_result !== "corrupt" &&
						data?.last_quick_skip_reason ? (
							<>
								{/* Most recent attempt was a skip — show the ATTEMPT time so
								    "(skipped)" doesn't sit next to a stale verified time. */}
								{formatRelative(data?.last_quick_attempt_at ?? null)}
								<span className="text-warning-strong"> (skipped)</span>
							</>
						) : (
							<>
								{formatRelative(data?.last_quick_check_at ?? null)}
								{data?.last_quick_result === "corrupt" ? (
									<span className="text-destructive-strong"> (corrupt)</span>
								) : null}
							</>
						)}
					</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Last full check</dt>
					<dd>
						{data?.last_full_result !== "corrupt" &&
						data?.last_full_skip_reason ? (
							<>
								{formatRelative(data?.last_full_attempt_at ?? null)}
								<span className="text-warning-strong"> (skipped)</span>
							</>
						) : (
							<>
								{formatRelative(data?.last_full_check_at ?? null)}
								{data?.last_full_result === "corrupt" ? (
									<span className="text-destructive-strong"> (corrupt)</span>
								) : null}
							</>
						)}
					</dd>
				</div>
			</dl>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={isRunning}
					onClick={() => onClick("quick")}
				>
					<RefreshCw className="h-4 w-4 mr-2" />
					Run quick check
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={isRunning}
					onClick={() => onClick("full")}
				>
					<RefreshCw className="h-4 w-4 mr-2" />
					Run full check
				</Button>
			</div>

			{triggerCheck.isError ? (
				<p role="alert" className="text-sm text-destructive-strong">
					Could not trigger check:{" "}
					{triggerCheck.error instanceof Error
						? triggerCheck.error.message
						: String(triggerCheck.error)}
				</p>
			) : null}
		</div>
	);
}

/**
 * Banner shown at the top of the Overview when DB corruption is detected.
 * Returns `null` when status is anything other than `corrupt` so the banner
 * doesn't take vertical space in the healthy case.
 *
 * A FAILED read is not the healthy case: `data` is undefined, which the
 * corrupt-check silently treats as "not corrupt". That renders an unknown
 * integrity state exactly like a verified-good one, so it gets its own
 * (quieter) banner instead.
 *
 * A read that failed AFTER a success is the same defect wearing a disguise:
 * React Query keeps the previous payload, so a stale verdict would otherwise be
 * presented as the current one. The cached verdict stays on screen — it is real
 * — but labelled with its age.
 */
export function StorageIntegrityBanner() {
	const { data, isError, dataUpdatedAt } = useStorageInfo();

	if (isError && data === undefined) {
		return (
			<div className="flex items-start gap-3 p-3 rounded-lg bg-warning/10 border border-warning/30">
				<AlertCircle className="h-5 w-5 text-warning-strong mt-0.5 shrink-0" />
				<div className="text-sm">
					<p className="font-medium">Database integrity status unavailable</p>
					<p className="text-muted-foreground">
						The storage endpoint could not be read, so corruption can neither be
						confirmed nor ruled out.
					</p>
				</div>
			</div>
		);
	}

	// Set only when a cached payload is on screen and the latest poll failed.
	const staleNote =
		isError && data !== undefined
			? `Last successful read ${staleAgeLabel(dataUpdatedAt)} — the latest refresh failed, so this verdict may no longer be current.`
			: null;

	if (data?.integrity_status === "corrupt") {
		return (
			<div
				role="alert"
				className="flex items-start gap-3 p-3 rounded-lg bg-destructive/15 border border-destructive/30"
			>
				<XCircle className="h-5 w-5 text-destructive-strong mt-0.5 shrink-0" />
				<div className="text-sm">
					<p className="font-medium text-destructive-strong">
						Database integrity check failed
					</p>
					<p className="text-muted-foreground">
						{data?.last_integrity_error ??
							"Check database integrity from System Health → Storage Integrity and review the server logs for details."}
					</p>
					{/* A failed refresh never downgrades a corruption report: the note
					    is APPENDED, so the destructive banner stays as-is. */}
					{staleNote ? (
						<p className="text-muted-foreground mt-1">{staleNote}</p>
					) : null}
				</div>
			</div>
		);
	}

	if (staleNote) {
		return (
			<div className="flex items-start gap-3 p-3 rounded-lg bg-warning/10 border border-warning/30">
				<AlertCircle className="h-5 w-5 text-warning-strong mt-0.5 shrink-0" />
				<div className="text-sm">
					<p className="font-medium">Database integrity status stale</p>
					<p className="text-muted-foreground">{staleNote}</p>
				</div>
			</div>
		);
	}

	return null;
}
