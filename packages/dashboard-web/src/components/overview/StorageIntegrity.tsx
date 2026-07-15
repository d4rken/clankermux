import {
	AlertTriangle,
	CheckCircle,
	Loader2,
	RefreshCw,
	XCircle,
} from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { useStorageInfo, useTriggerIntegrityCheck } from "../../hooks/queries";
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
 * check buttons) without a surrounding Card — designed to be embedded as a
 * sub-section of the System Status card. The sticky corruption banner lives in
 * {@link StorageIntegrityBanner}.
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
		icon = <XCircle className="h-5 w-5 text-destructive" />;
		label = "Database corruption detected";
		description = data?.last_integrity_error ?? "See server logs for details.";
		badgeNode = <Badge variant="destructive">Corrupt</Badge>;
	} else if (status === "skipped") {
		// A check could not complete (worker timeout / error / defensive
		// size-skip). This is NOT proven corruption — surface it amber and
		// reassure with the last VERIFIED verdict, so a slow full check on a
		// huge DB never lights the red corruption UI.
		tone = "warn";
		icon = <AlertTriangle className="h-5 w-5 text-warning" />;
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
		icon = <CheckCircle className="h-5 w-5 text-success" />;
		label = "Database integrity verified";
		description =
			data?.last_full_check_at != null
				? `Last full check ${formatRelative(data.last_full_check_at)}`
				: data?.last_quick_check_at != null
					? `Last quick check ${formatRelative(data.last_quick_check_at)} — full check still pending`
					: "—";
		badgeNode = (
			<Badge variant="default" className="bg-success">
				Healthy
			</Badge>
		);
	} else {
		tone = "warn";
		icon = <AlertTriangle className="h-5 w-5 text-warning" />;
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
		<div className="text-sm text-destructive">
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
								<span className="text-warning"> (skipped)</span>
							</>
						) : (
							<>
								{formatRelative(data?.last_quick_check_at ?? null)}
								{data?.last_quick_result === "corrupt" ? (
									<span className="text-destructive"> (corrupt)</span>
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
								<span className="text-warning"> (skipped)</span>
							</>
						) : (
							<>
								{formatRelative(data?.last_full_check_at ?? null)}
								{data?.last_full_result === "corrupt" ? (
									<span className="text-destructive"> (corrupt)</span>
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
				<p role="alert" className="text-sm text-destructive">
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
 * Sticky banner shown across the dashboard when DB corruption is detected.
 * Returns `null` when status is anything other than `corrupt` so the banner
 * doesn't take vertical space in the healthy case.
 */
export function StorageIntegrityBanner() {
	const { data } = useStorageInfo();
	if (data?.integrity_status !== "corrupt") return null;
	return (
		<div
			role="alert"
			className="flex items-start gap-3 p-3 rounded-lg bg-destructive/15 border border-destructive/30"
		>
			<XCircle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
			<div className="text-sm">
				<p className="font-medium text-destructive">
					Database integrity check failed
				</p>
				<p className="text-muted-foreground">
					{data?.last_integrity_error ??
						"Check database integrity from the Overview (Storage / Integrity) and review the server logs for details."}
				</p>
			</div>
		</div>
	);
}
