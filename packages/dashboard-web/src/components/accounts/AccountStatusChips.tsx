import type {
	AccountResponse,
	CodexRateLimitResetCreditConsumeOutcome,
	CodexResetCreditEventResponse,
	DevinGracePeriodStatus,
} from "@clankermux/types";
import { formatUsd } from "@clankermux/ui-common";
import {
	AlertCircle,
	CalendarClock,
	Copy,
	Pause,
	RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import {
	type AccountStatus,
	deriveAccountStatus,
	type ResetCreditUrgency,
} from "../../lib/account-status";
import { randomUUID } from "../../lib/uuid";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { AccountPolicyChips } from "./AccountPolicyChips";
import { RateLimitStatusChip } from "./RateLimitStatusChip";
import { StatusChip } from "./StatusChip";

/**
 * Codex sells credits at a flat €0.04 each — the rate card is perfectly linear
 * across every tier (1000 cr = €40, 5000 cr = €200, …), so credits→EUR is an
 * exact conversion, not an estimate. Update this one constant if OpenAI ever
 * reprices. (Codex balances are credits; Anthropic overage is billed in USD and
 * is not surfaced as a balance here.)
 */
const EUR_PER_CODEX_CREDIT = 0.04;

/** "2430 cr (€97.21)" — native credits remaining plus their exact EUR value. */
function formatCodexCreditBalance(credits: number): string {
	const eur = (credits * EUR_PER_CODEX_CREDIT).toFixed(2);
	return `${Math.round(credits)} cr (€${eur})`;
}

/**
 * "Re-auth in 5 days" — days, not `formatDuration`'s hours, because this label
 * only ever appears inside the final week and "144.0h" is a worse way to say
 * "six days". Takes the already-derived day count rather than a deadline plus
 * its own `Date.now()`, so the label cannot drift from the status flag that
 * decides which form of the chip renders.
 */
function formatReauthDeadline(daysRemaining: number): string {
	if (daysRemaining <= 0) return "Re-auth overdue";
	// "within 24h", not "today": the count is a duration, so at 23:30 a deadline
	// of 00:30 reads "today" while it in fact falls tomorrow. Naming the duration
	// keeps the label true on either side of midnight.
	if (daysRemaining === 1) return "Re-auth within 24h";
	return `Re-auth in ${daysRemaining} days`;
}

/** "Re-auth by Mar 4, 2026" — the far-out form, where a day count is noise. */
function formatReauthDeadlineDate(deadlineMs: number): string {
	return `Re-auth by ${new Date(deadlineMs).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	})}`;
}

/** Tooltip shared by both forms of the re-auth chip. */
function reauthDeadlineTitle(deadlineMs: number): string {
	return `This account's OAuth refresh token expires on ${new Date(
		deadlineMs,
	).toLocaleString()}. Token rotation does not extend that deadline, so the account will auto-pause mid-rotation unless it is re-authenticated first. Re-authenticate it from the Accounts tab at any time before then.`;
}

interface AccountStatusChipsProps {
	account: AccountResponse;
	/** Pre-derived status; falls back to deriving from `account` when omitted. */
	status?: AccountStatus;
	/** Omit details when the host places them in its account header. */
	showAccountDetails?: boolean;
	/** Usage focuses on capacity and active problems, omitting account settings. */
	variant?: "account" | "usage";
}

/**
 * Shared amber/red urgency palette for time-pressure chips — spread into both
 * the reset-credit and renewal chip class maps so the two stay in sync.
 */
const URGENCY_BASE_CLASSES = {
	imminent: "bg-destructive/15 text-destructive-strong",
	soon: "bg-warning/15 text-warning-strong",
} as const;

/**
 * Chip color by reset-credit urgency — same amber/red Tailwind palette as the
 * renewal chip (`RENEWAL_URGENCY_CLASSES`), sky when nothing expires soon.
 */
const RESET_CREDIT_URGENCY_CLASSES: Record<ResetCreditUrgency, string> = {
	...URGENCY_BASE_CLASSES,
	none: "bg-info/15 text-info",
};

const RESET_EVENT_STATUS_LABELS: Record<
	CodexResetCreditEventResponse["status"],
	string
> = {
	pending: "Pending",
	reset: "Reset applied",
	nothingToReset: "Nothing to reset",
	noCredit: "No credit available",
	alreadyRedeemed: "Already redeemed",
	failed: "Failed",
};

/** Cap on the inline error text per event row; full message stays in `title`. */
const MAX_EVENT_ERROR_CHARS = 120;

/** Human label for why an auto reset attempt was claimed. */
const RESET_EVENT_CAUSE_LABELS: Record<
	NonNullable<CodexResetCreditEventResponse["cause"]>,
	string
> = {
	expiry: "expiry",
	"weekly-limit": "weekly limit",
};

/** Inline outcome copy for the manual Apply-now flow, keyed by API outcome. */
const CONSUME_OUTCOME_LABELS: Record<
	CodexRateLimitResetCreditConsumeOutcome,
	string
> = {
	reset: "Reset applied — usage windows cleared",
	nothingToReset: "Nothing to reset",
	noCredit: "No credit available",
	alreadyRedeemed: "Already redeemed",
};

/** Lazy-load lifecycle of the reset-credit event history in the popover. */
export type ResetCreditEventsState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "loaded"; events: CodexResetCreditEventResponse[] };

function formatEventTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Presentational body of the reset-credit history popover. Exported (pure,
 * state-in) so the loading / error / empty / list states are unit-testable
 * with static markup.
 */
export function ResetCreditEventsPanel({
	state,
}: {
	state: ResetCreditEventsState;
}) {
	if (state.kind === "idle" || state.kind === "loading") {
		return (
			<p className="text-xs text-muted-foreground">Loading reset events…</p>
		);
	}
	if (state.kind === "error") {
		return (
			<p className="text-xs text-destructive-strong">
				Failed to load reset events: {state.message}
			</p>
		);
	}
	if (state.events.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No reset events yet. Manual and automatic reset attempts will appear
				here.
			</p>
		);
	}
	return (
		<ul className="space-y-item">
			{state.events.map((event) => (
				<li key={event.id} className="text-xs space-y-tight">
					<div className="flex flex-wrap items-center gap-item">
						<span className="text-muted-foreground whitespace-nowrap">
							{formatEventTime(event.createdAt)}
						</span>
						{/* `px-1.5` stays numeric: 0.375rem maps to no step on the
						    rhythm scale, and this micro-pill sits tighter than the
						    0.5rem `item` step would allow. */}
						<span
							className={`px-1.5 py-0 rounded-md label-caps ${
								event.trigger === "auto"
									? "bg-info/15 text-info"
									: "bg-secondary text-secondary-foreground"
							}`}
						>
							{event.trigger === "auto" && event.cause
								? `auto · ${RESET_EVENT_CAUSE_LABELS[event.cause]}`
								: event.trigger}
						</span>
						<span className="font-medium">
							{RESET_EVENT_STATUS_LABELS[event.status]}
						</span>
						{event.windowsReset != null && event.windowsReset > 0 && (
							<span className="text-muted-foreground">
								{event.windowsReset} window
								{event.windowsReset === 1 ? "" : "s"} reset
							</span>
						)}
					</div>
					{event.errorMessage && (
						<p className="text-destructive-strong" title={event.errorMessage}>
							{event.errorMessage.length > MAX_EVENT_ERROR_CHARS
								? `${event.errorMessage.slice(0, MAX_EVENT_ERROR_CHARS)}…`
								: event.errorMessage}
						</p>
					)}
				</li>
			))}
		</ul>
	);
}

/**
 * Lifecycle of the manual "Apply now" reset-credit consume flow. The
 * idempotency key is deliberately NOT part of this state — the chip holds it
 * separately so an error-retry can reuse the same key.
 */
export type ResetCreditApplyState =
	| { kind: "idle" }
	| { kind: "confirm" }
	| { kind: "applying" }
	| {
			kind: "done";
			outcome: CodexRateLimitResetCreditConsumeOutcome;
			message: string;
	  }
	| { kind: "error"; message: string };

/**
 * Presentational Apply-now confirm/outcome flow rendered inside the
 * reset-credit popover. Exported (pure, state-in) so every step — hidden at
 * zero credits, armed confirm, in-flight, business outcomes and the transport
 * error with its Retry affordance — is unit-testable with static markup,
 * mirroring `ResetCreditEventsPanel`.
 */
export function ResetCreditApplyPanel({
	accountName,
	availableCount,
	state,
	onArm,
	onConfirm,
	onCancel,
	onRetry,
	onDismiss,
}: {
	accountName: string;
	availableCount: number;
	state: ResetCreditApplyState;
	onArm: () => void;
	onConfirm: () => void;
	onCancel: () => void;
	onRetry: () => void;
	/** Dismiss a terminal outcome — the parent resets the flow back to idle. */
	onDismiss: () => void;
}) {
	if (state.kind === "idle") {
		// The button only appears while a reset credit is actually available.
		if (availableCount <= 0) return null;
		return (
			<Button
				variant="outline"
				size="sm"
				className="h-7 text-xs"
				onClick={onArm}
				title="Consume one banked usage reset now to clear this account's usage windows"
			>
				Apply now
			</Button>
		);
	}
	if (state.kind === "confirm") {
		return (
			<div className="space-y-item">
				<p className="text-xs">
					Consume 1 reset for <span className="font-medium">{accountName}</span>
					?
				</p>
				<div className="flex items-center gap-item">
					<Button size="sm" className="h-7 text-xs" onClick={onConfirm}>
						Confirm
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={onCancel}
					>
						Cancel
					</Button>
				</div>
			</div>
		);
	}
	if (state.kind === "applying") {
		return <p className="text-xs text-muted-foreground">Applying reset…</p>;
	}
	if (state.kind === "error") {
		return (
			<div className="space-y-item">
				<p className="text-xs text-destructive-strong" title={state.message}>
					Failed to apply reset: {state.message}
				</p>
				<div className="flex items-center gap-item">
					<Button size="sm" className="h-7 text-xs" onClick={onRetry}>
						Retry
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={onCancel}
					>
						Cancel
					</Button>
				</div>
			</div>
		);
	}
	// "done" — show the outcome plus a way back to idle, so the Apply-now
	// button doesn't disappear permanently after a single use.
	return (
		<div className="space-y-item">
			<p
				className={`text-xs ${
					state.outcome === "reset"
						? "text-success-strong"
						: "text-muted-foreground"
				}`}
			>
				{state.message}
			</p>
			<Button
				variant="outline"
				size="sm"
				className="h-7 text-xs"
				onClick={onDismiss}
			>
				Done
			</Button>
		</div>
	);
}

function CodexUsageResetChip({
	account,
	status,
}: {
	account: AccountResponse;
	status: AccountStatus;
}) {
	const [eventsState, setEventsState] = useState<ResetCreditEventsState>({
		kind: "idle",
	});
	const [applyState, setApplyState] = useState<ResetCreditApplyState>({
		kind: "idle",
	});
	// Idempotency key of the currently-armed consume attempt. Generated ONCE per
	// arm, reused across error-retries so the backend can dedupe, cleared on a
	// terminal business outcome or cancel.
	const [applyIdempotencyKey, setApplyIdempotencyKey] = useState<string | null>(
		null,
	);
	const summary = account.codexRateLimitResetCredits;
	if (account.provider !== "codex" || !summary) return null;

	const loadEvents = () => {
		setEventsState({ kind: "loading" });
		api
			.getAccountResetCreditEvents(account.id, 20)
			.then((events) => setEventsState({ kind: "loaded", events }))
			.catch((error: unknown) =>
				setEventsState({
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				}),
			);
	};

	const runConsume = (idempotencyKey: string) => {
		setApplyState({ kind: "applying" });
		api
			.consumeAccountResetCredit(account.id, idempotencyKey)
			.then((response) => {
				// Terminal business outcome — the attempt is settled, drop the key.
				setApplyIdempotencyKey(null);
				setApplyState({
					kind: "done",
					outcome: response.outcome,
					message: CONSUME_OUTCOME_LABELS[response.outcome] ?? response.message,
				});
				// Refresh the ledger below; the chip's own count/expiry refreshes with
				// the Accounts page's periodic poll (no refresh callback is plumbed
				// into the chips).
				loadEvents();
			})
			.catch((error: unknown) => {
				// Transport/server failure — keep the key so Retry reuses it.
				setApplyState({
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				});
			});
	};

	const handleArm = () => {
		const key = randomUUID();
		setApplyIdempotencyKey(key);
		setApplyState({ kind: "confirm" });
	};
	const handleConfirmOrRetry = () => {
		if (applyIdempotencyKey) runConsume(applyIdempotencyKey);
	};
	// Cancel and dismiss share the same reset: clear any held idempotency key
	// and return the flow to idle (re-showing Apply now while credits remain).
	const handleCancel = () => {
		setApplyIdempotencyKey(null);
		setApplyState({ kind: "idle" });
	};

	const availableExpiries = status.resetCreditAvailableExpiries;
	const nextExpiry = status.resetCreditNextExpiry;
	const countLabel = `${summary.availableCount} usage reset${summary.availableCount === 1 ? "" : "s"}`;
	const shortExpiry = nextExpiry?.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	const label = shortExpiry
		? `${countLabel} · ${summary.availableCount === 1 ? "expires" : "next expires"} ${shortExpiry}`
		: countLabel;

	const expiryDetails = availableExpiries.length
		? ` Expirations: ${availableExpiries
				.map((date) => date.toLocaleString())
				.join("; ")}.`
		: summary.availableCount > 0
			? " Per-reset expiration details are unavailable."
			: "";
	const expiryArmed = status.resetCreditAutoApplyArmed;
	const weeklyArmed = status.resetCreditAutoApplyOnWeeklyLimitArmed;
	const autoApplyLine =
		summary.availableCount > 0
			? expiryArmed && weeklyArmed
				? " Auto-apply armed (expiry + weekly limit) — a reset will be consumed automatically shortly before expiry, or at the weekly limit when no usable Codex alternative is available. Manual pauses defer weekly resets."
				: expiryArmed
					? " Auto-apply armed — a reset will be consumed automatically shortly before expiry."
					: weeklyArmed
						? " Auto-apply armed (weekly limit) — a reset will be consumed automatically at the weekly limit when no usable Codex alternative is available. Manual pauses defer weekly resets."
						: " Auto-apply is off — this reset may expire unused."
			: "";

	const colorClasses =
		summary.availableCount > 0
			? RESET_CREDIT_URGENCY_CLASSES[status.resetCreditUrgency]
			: "bg-secondary text-muted-foreground";

	const handleOpenChange = (open: boolean) => {
		if (open && eventsState.kind === "idle") {
			loadEvents();
		}
		// A terminal outcome from a previous visit is stale on reopen — reset the
		// Apply-now flow so the button is available again.
		if (open && applyState.kind === "done") {
			handleCancel();
		}
	};

	return (
		<Popover onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<StatusChip
					className={`cursor-pointer ${colorClasses}`}
					title={`${countLabel} available.${expiryDetails}${autoApplyLine} Click for reset history.`}
				>
					<RotateCcw className="h-3.5 w-3.5" />
					{label}
				</StatusChip>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-row space-y-row">
				<ResetCreditApplyPanel
					accountName={account.name}
					availableCount={summary.availableCount}
					state={applyState}
					onArm={handleArm}
					onConfirm={handleConfirmOrRetry}
					onCancel={handleCancel}
					onRetry={handleConfirmOrRetry}
					onDismiss={handleCancel}
				/>
				<div>
					<p className="text-xs font-medium mb-item">Usage-reset history</p>
					<ResetCreditEventsPanel state={eventsState} />
				</div>
			</PopoverContent>
		</Popover>
	);
}

/** "haiku" → "Haiku" for the family-scoped overload/probing chips. */
function formatFamilyLabel(family: string): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

/**
 * Providers that lift a `subscription_expired` pause themselves once the
 * subscription is live again: Codex when its spend capture reads an active
 * plan, Anthropic when usage polling recovers. No other provider has a resume
 * path — a Devin seat restored upstream looks identical to a lapsed one — so
 * its seat stays paused until someone resumes it.
 *
 * Pinned by the D8 case in `AccountStatusChips.test.tsx`.
 */
const SELF_RESUMING_SUBSCRIPTION_PROVIDERS = new Set(["codex"]);

/** Tooltip of the "Subscription expired" chip; the recovery clause is per provider. */
function subscriptionExpiredTitle(provider: string): string {
	if (provider === "anthropic") {
		return "Anthropic denied usage access and its profile confirmed that the paid subscription has ended. Renew your subscription to restore access. Background checks continue, and this automatic pause clears when usage access returns.";
	}
	const cause =
		"The provider refused this account because its subscription no longer covers the service — a lapsed plan, a cancelled subscription, or a seat removed from a team. It was auto-paused and no retries are scheduled against it.";
	return SELF_RESUMING_SUBSCRIPTION_PROVIDERS.has(provider)
		? `${cause} Renew or restore the seat; the pause lifts on its own once the provider reports an active subscription again.`
		: `${cause} Renew or restore the seat, then resume the account by hand — nothing here lifts this pause for you.`;
}

/**
 * The per-account status chip row shared by the Accounts page (`AccountListItem`)
 * and the Usage page (`AccountUtilizationCard`). Usage omits routing, renewal,
 * automation settings and routine off-peak / zero-reset indicators. Active
 * warnings and capacity information share `deriveAccountStatus`. Action buttons
 * (e.g. Force Reset) and request/session stats are left to the host, as is the
 * pause state — both render `AccountPausedChip` in their heading row.
 */
export function AccountStatusChips({
	account,
	status: providedStatus,
	showAccountDetails = true,
	variant = "account",
}: AccountStatusChipsProps) {
	const status = providedStatus ?? deriveAccountStatus(account);
	const isUsage = variant === "usage";
	const includeAccountDetails = showAccountDetails && !isUsage;

	return (
		<div
			className={`flex flex-wrap items-center gap-item text-sm${isUsage ? " empty:hidden" : ""}`}
			data-testid="account-status-chips"
		>
			{includeAccountDetails && <AccountRoutingChips status={status} />}
			{status.isRateLimited && (
				<span title="Account is rate-limited - requests will be rejected until the limit resets">
					<AlertCircle className="h-4 w-4 text-warning-strong" />
				</span>
			)}
			{status.isUsagePermissionDenied && (
				<StatusChip
					className="bg-destructive/15 text-destructive-strong"
					title="Anthropic denied access to this account's usage data. Check organization permissions and subscription access. This pause clears when usage access returns; a separate Claude Code access restriction must recover independently."
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Usage access denied
				</StatusChip>
			)}
			{status.isSubscriptionExpired && (
				<StatusChip
					className="bg-destructive/15 text-destructive-strong"
					title={subscriptionExpiredTitle(account.provider)}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Subscription expired
				</StatusChip>
			)}
			{account.rateLimitedReason === "org_permission_denied" && (
				<StatusChip
					className="bg-destructive/15 text-destructive-strong"
					title="The organization disabled OAuth or Claude Code subscription access. Ask an admin to restore it. While cooling down, the account is skipped. Once eligible again, requests check recovery one at a time until access is confirmed; routing pins still apply."
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Organization access disabled
				</StatusChip>
			)}
			{status.isNeedsReauth && (
				<StatusChip
					className="bg-destructive/15 text-destructive-strong"
					title="This account's OAuth refresh token was rejected (invalid_grant). It was auto-paused and removed from rotation. Re-authenticate it from the Accounts tab — it will auto-resume on success."
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Needs re-authentication
				</StatusChip>
			)}
			{/* One chip for the whole life of the deadline: neutral with the date
			    while it is far out, amber once inside the warning window. The point
			    of capturing the deadline is that it stops being a surprise, and a
			    date that only surfaces in its final week is still a surprise for the
			    months before it. Suppressed once the token has actually been
			    rejected — the terminal chip above already says so, and there is no
			    deadline left to plan around. */}
			{!status.isNeedsReauth &&
				status.reauthDeadlineMs !== null &&
				(status.isReauthDueSoon && status.reauthDaysRemaining !== null ? (
					<StatusChip
						className="bg-warning/15 text-warning-strong"
						title={reauthDeadlineTitle(status.reauthDeadlineMs)}
					>
						<CalendarClock className="h-3.5 w-3.5" />
						{formatReauthDeadline(status.reauthDaysRemaining)}
					</StatusChip>
				) : (
					// Usage reports capacity and active problems; a deadline three
					// weeks out is neither, so the far-out form is Accounts-only.
					!isUsage && (
						<StatusChip
							className="bg-secondary text-secondary-foreground"
							title={reauthDeadlineTitle(status.reauthDeadlineMs)}
						>
							<CalendarClock className="h-3.5 w-3.5" />
							{formatReauthDeadlineDate(status.reauthDeadlineMs)}
						</StatusChip>
					)
				))}
			{status.showRateLimitChip && (
				<RateLimitStatusChip
					status={status.rateLimitStatus}
					cause={status.rateLimitCause}
					binding={status.rateLimitCauseBinding}
					resetMs={status.rateLimitCauseResetMs}
					providerStatus={status.rateLimitProviderStatus}
				/>
			)}
			{status.staleLockDetected && (
				<span
					className="text-warning-strong"
					title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
				>
					Stale lock detected
				</span>
			)}
			{status.isUsageThrottled && (
				<span
					className="text-warning-strong"
					title="Usage throttling is delaying requests for this account until pacing catches up"
				>
					Usage throttled
				</span>
			)}
			{status.providerOverloadedUntil && (
				<StatusChip
					className="bg-warning/15 text-warning-strong"
					title={`Provider overload cooldown active until ${new Date(
						status.providerOverloadedUntil,
					).toLocaleString()}`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Provider overloaded ({status.providerOverloadMinutes}m)
				</StatusChip>
			)}
			{status.isProviderProbing && (
				<StatusChip
					className="bg-info/15 text-info"
					title="Provider overload cooldown elapsed — a single probe request will test whether the upstream has recovered before traffic resumes"
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Probing recovery
				</StatusChip>
			)}
			{status.overloadedFamilies.map((entry) => (
				<StatusChip
					key={entry.family}
					className="bg-warning/15 text-warning-strong"
					title={`Upstream overload for the ${formatFamilyLabel(entry.family)} model family — breaker open until ${new Date(
						entry.until,
					).toLocaleString()}. Other model families keep routing to this account.`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Overloaded: {formatFamilyLabel(entry.family)} ({entry.minutes}m)
				</StatusChip>
			))}
			{status.probingFamilies.map((family) => (
				<StatusChip
					key={family}
					className="bg-info/15 text-info"
					title={`${formatFamilyLabel(family)} overload cooldown elapsed — a single probe request will test whether the upstream has recovered before traffic resumes`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Probing: {formatFamilyLabel(family)}
				</StatusChip>
			))}
			{status.exhaustedScopedFamilies.map((entry) => (
				<StatusChip
					key={entry.familyKey}
					className="bg-warning/15 text-warning-strong"
					title={`The ${entry.label} model family's weekly quota is exhausted on this account until ${new Date(
						entry.resetsAtMs,
					).toLocaleString()}. Other model families keep routing to this account.`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					{entry.label} weekly exhausted ({entry.hoursLeft}h)
				</StatusChip>
			))}
			{status.isOnCredits && (
				<StatusChip
					className="bg-warning/15 text-warning-strong"
					title={`Weekly limit reached — account is drawing on purchased credits.${
						status.creditsBalance != null
							? ` ${Math.round(status.creditsBalance)} credits remaining ≈ €${(
									status.creditsBalance * EUR_PER_CODEX_CREDIT
								).toFixed(2)} (€${EUR_PER_CODEX_CREDIT.toFixed(2)}/credit).`
							: ""
					}${status.creditsPlanType ? ` Plan: ${status.creditsPlanType}.` : ""}`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					On credits
					{status.creditsBalance != null
						? ` · ${formatCodexCreditBalance(status.creditsBalance)}`
						: ""}
					{status.creditsPlanType ? ` · ${status.creditsPlanType}` : ""}
				</StatusChip>
			)}
			{(!isUsage ||
				(account.codexRateLimitResetCredits?.availableCount ?? 0) > 0) && (
				<CodexUsageResetChip account={account} status={status} />
			)}
			{status.showPeakChip && (!isUsage || status.isPeak) && (
				<StatusChip
					className={
						status.isPeak
							? "bg-warning/15 text-warning-strong"
							: "bg-success/15 text-success-strong"
					}
				>
					<span
						className={`h-1.5 w-1.5 rounded-full ${status.isPeak ? "bg-warning" : "bg-success"}`}
					/>
					{status.peakChipLabel}
				</StatusChip>
			)}
			{includeAccountDetails && status.showRenewalChip && (
				<AccountRenewalInfo account={account} status={status} />
			)}
			<DevinGracePeriodChip account={account} />
			{status.isDuplicateAccount && (
				<StatusChip
					className="bg-warning/15 text-warning-strong"
					title={`Shares provider identity with ${status.duplicateAccountIds.length} other account(s)`}
				>
					<Copy className="h-3.5 w-3.5" />
					Duplicate
				</StatusChip>
			)}
			{/* The account's automation-flag inventory, always last: the pills above
			    are transient state, these are configuration. A fragment, so they
			    wrap as individual flex items of this row rather than as a block. */}
			{!isUsage && <AccountPolicyChips account={account} />}
		</div>
	);
}

/**
 * Whether the account is in rotation at all, rendered in the heading row beside
 * the name rather than among the status chips below it. A pause outranks every
 * chip in that row: it is the reason the priority, the overload cooldowns and
 * the quota bars describe an account no request can reach. Warning-tinted for
 * the same reason every other "not taking traffic" chip in this file is — the
 * pause being deliberate does not give the pool back its capacity. The causes
 * that pause an account on their own (`Needs re-authentication`,
 * `Usage access denied`) keep their louder chips below, so this one says that
 * traffic stopped and they say why.
 */
export function AccountPausedChip({
	account,
	status,
}: {
	account: AccountResponse;
	status: AccountStatus;
}) {
	if (!status.isPaused) return null;
	const devinQuotaPause =
		account.provider === "devin" &&
		(account.pauseReason === "overage" ||
			account.pauseReason === "rate_limit_window");
	return (
		<StatusChip
			className="bg-warning/15 text-warning-strong"
			title={
				devinQuotaPause
					? "Included quota is exhausted or unavailable. Auto-recover quota resumes this account after metadata confirms available capacity. If your plan reports no allowance, review Allow requests beyond verified included quota before resuming manually."
					: "This account is out of rotation and serves no requests until it is resumed."
			}
		>
			<Pause className="h-3.5 w-3.5" />
			{devinQuotaPause ? "Paused: included quota" : "Paused"}
		</StatusChip>
	);
}

/** Account-level routing details, also used in the Accounts page heading. */
export function AccountRoutingChips({ status }: { status: AccountStatus }) {
	return (
		<>
			{status.isPrimary && (
				<StatusChip className="bg-primary text-primary-foreground">
					Primary
				</StatusChip>
			)}
			<StatusChip className="bg-secondary text-secondary-foreground">
				Priority: {status.priority}
			</StatusChip>
		</>
	);
}

const RENEWAL_URGENCY_CLASSES: Record<string, string> = {
	...URGENCY_BASE_CLASSES,
	none: "bg-secondary text-secondary-foreground",
	past: "bg-secondary text-secondary-foreground",
};

/**
 * Subscription renewal, optionally rendered as plain inline text. Amber when
 * renewal is near, red when imminent,
 * muted for far-off or already-elapsed one-time dates. Only rendered when
 * `status.showRenewalChip` is true (a renewal date is set and no live refusal
 * contradicts it — see `deriveAccountStatus`).
 *
 * Three wordings, by what is actually known:
 *
 *   "Renews Oct 3 (17d)"  — a date, with no report that it will not recur.
 *   "Ends Oct 3 (17d)"    — the provider reported `will_renew: false`.
 *   "Ended Aug 3"         — a provider-reported period end that has passed.
 */
export function AccountRenewalInfo({
	account,
	status,
	inline = false,
}: {
	account: AccountResponse;
	status: AccountStatus;
	inline?: boolean;
}) {
	const nextDate = status.renewalNextDate;
	if (!status.showRenewalChip || !nextDate) return null;

	const shortDate = nextDate.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	// ISO YYYY-MM-DD of the local next date for the tooltip. en-CA renders a
	// local Date as YYYY-MM-DD without the UTC shift that toISOString() causes.
	const isoDate = nextDate.toLocaleDateString("en-CA");
	const cadence = account.renewalCadence ?? "none";

	const isPast = status.renewalUrgency === "past";
	const daysLeft = status.renewalDaysLeft;
	// A derived anchor is the subscription's START day-of-month, not a billing
	// date the provider reported — no Anthropic endpoint exposes one. The "~"
	// is the only thing separating a guess from an operator-confirmed date. A
	// provider anchor IS a reported date, so it carries no mark.
	const isDerived = account.renewalAnchorSource === "derived";
	const isProviderReported = account.renewalAnchorSource === "provider";
	const dateMark = isDerived ? "~" : "";
	// Only a reported `false` relabels the date: null means the provider said
	// nothing about renewing, which is not the same as saying it will not.
	const willNotRenew =
		isProviderReported && account.identitySubscriptionWillRenew === false;

	let label: string;
	if (isPast) {
		// A past one-time date only means the configured date has elapsed — the
		// system never verifies the provider actually renewed, so don't claim
		// "Renewed". (`past` only occurs for cadence='none'; recurring cadences
		// always resolve to a future date.)
		label = isProviderReported
			? `Ended ${shortDate}`
			: `Renewal date passed (${shortDate})`;
	} else {
		const verb = willNotRenew ? "Ends" : "Renews";
		const when = daysLeft === 0 ? "today" : `${daysLeft}d`;
		label = `${verb} ${dateMark}${shortDate} (${when})`;
	}

	const priceSuffix =
		account.renewalPriceUsd != null
			? ` · ${formatUsd(account.renewalPriceUsd)}/renewal`
			: "";
	const derivedSuffix = isDerived
		? " · Estimated from the subscription start; the provider reports no renewal date. Set it to confirm."
		: "";

	let titleBase: string;
	if (isProviderReported) {
		titleBase = isPast
			? `The provider-reported subscription period ended on ${isoDate}`
			: `The provider reports the current subscription period ends ${isoDate}${
					willNotRenew ? ", and that it will not renew" : ""
				}`;
	} else if (isPast) {
		titleBase = `Configured one-time renewal date passed on ${isoDate}; provider renewal was not verified`;
	} else {
		titleBase = `Subscription renews ${isoDate} (${cadence})`;
	}
	const title = titleBase + priceSuffix + derivedSuffix;

	const colorClasses =
		RENEWAL_URGENCY_CLASSES[status.renewalUrgency] ??
		RENEWAL_URGENCY_CLASSES.none;

	if (inline) {
		const textColor =
			status.renewalUrgency === "imminent"
				? "text-destructive-strong"
				: status.renewalUrgency === "soon"
					? "text-warning-strong"
					: "text-muted-foreground";
		return (
			<span className={`whitespace-nowrap ${textColor}`} title={title}>
				{label + priceSuffix}
			</span>
		);
	}

	return (
		<StatusChip className={colorClasses} title={title}>
			<CalendarClock className="h-3.5 w-3.5" />
			{label + priceSuffix}
		</StatusChip>
	);
}

const DEVIN_GRACE_CHIP_CLASSES: Record<
	Exclude<DevinGracePeriodStatus, "none">,
	string
> = {
	active: "bg-warning/15 text-warning-strong",
	expired: "bg-destructive/15 text-destructive-strong",
};

/**
 * Devin's reported `PlanStatus.gracePeriodStatus`, with its end date when the
 * message carried one. DISPLAY ONLY: the enum's semantics are undocumented and
 * no public consumer branches on it, so it never feeds a pause, a routing
 * decision or eligibility — a lapse that matters arrives separately, as the
 * request-path refusal that sets `subscription_expired`.
 *
 *   active  → "Grace period until Aug 17"
 *   expired → "Grace period ended Aug 17"
 *
 * `none` is the enum's healthy member, not an absence, and renders nothing.
 */
function DevinGracePeriodChip({ account }: { account: AccountResponse }) {
	const usage = account.usageData;
	// `FullUsageData` is not discriminated on `kind` — AnthropicUsageData
	// carries no such field — so the presence test comes before the comparison.
	if (!usage || !("kind" in usage) || usage.kind !== "devin") return null;
	const graceStatus = usage.gracePeriodStatus ?? null;
	if (graceStatus === null || graceStatus === "none") return null;

	const endsAtMs = usage.gracePeriodEndMs ?? null;
	const endsAt = endsAtMs !== null ? new Date(endsAtMs) : null;
	const shortDate =
		endsAt?.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		}) ?? null;
	// en-CA renders a local Date as YYYY-MM-DD without the UTC shift
	// toISOString() causes.
	const isoDate = endsAt?.toLocaleDateString("en-CA") ?? null;

	let label: string;
	let title: string;
	if (graceStatus === "active") {
		label = shortDate ? `Grace period until ${shortDate}` : "Grace period";
		title = isoDate
			? `Devin reports this seat is in a grace period until ${isoDate}. Billing state only — it does not pause the account or change routing.`
			: "Devin reports this seat is in a grace period, with no end date. Billing state only — it does not pause the account or change routing.";
	} else {
		label = shortDate
			? `Grace period ended ${shortDate}`
			: "Grace period ended";
		title = isoDate
			? `Devin reports this seat's grace period ended on ${isoDate}. Billing state only — the account is paused, if at all, by the provider refusing a request.`
			: "Devin reports this seat's grace period has ended. Billing state only — the account is paused, if at all, by the provider refusing a request.";
	}

	return (
		<StatusChip className={DEVIN_GRACE_CHIP_CLASSES[graceStatus]} title={title}>
			<CalendarClock className="h-3.5 w-3.5" />
			{label}
		</StatusChip>
	);
}
