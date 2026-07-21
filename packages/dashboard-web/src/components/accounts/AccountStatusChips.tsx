import type {
	AccountResponse,
	CodexRateLimitResetCreditConsumeOutcome,
	CodexResetCreditEventResponse,
} from "@clankermux/types";
import { formatUsd } from "@clankermux/ui-common";
import { AlertCircle, CalendarClock, RotateCcw } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import {
	type AccountStatus,
	deriveAccountStatus,
	type ResetCreditUrgency,
} from "../../lib/account-status";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { RateLimitStatusChip } from "./RateLimitStatusChip";

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

interface AccountStatusChipsProps {
	account: AccountResponse;
	/** Pre-derived status; falls back to deriving from `account` when omitted. */
	status?: AccountStatus;
}

/**
 * Shared amber/red urgency palette for time-pressure chips — spread into both
 * the reset-credit and renewal chip class maps so the two stay in sync.
 */
const URGENCY_BASE_CLASSES = {
	imminent: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
	soon: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
} as const;

/**
 * Chip color by reset-credit urgency — same amber/red Tailwind palette as the
 * renewal chip (`RENEWAL_URGENCY_CLASSES`), sky when nothing expires soon.
 */
const RESET_CREDIT_URGENCY_CLASSES: Record<ResetCreditUrgency, string> = {
	...URGENCY_BASE_CLASSES,
	none: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
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
 * with static markup — the repo has no DOM test harness to click the trigger.
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
			<p className="text-xs text-destructive">
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
		<ul className="space-y-2">
			{state.events.map((event) => (
				<li key={event.id} className="text-xs space-y-0.5">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
						<span className="text-muted-foreground whitespace-nowrap">
							{formatEventTime(event.createdAt)}
						</span>
						<span
							className={`px-1.5 py-0 rounded-full text-[10px] font-medium uppercase ${
								event.trigger === "auto"
									? "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
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
						<p className="text-destructive" title={event.errorMessage}>
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
			<div className="space-y-1.5">
				<p className="text-xs">
					Consume 1 reset for <span className="font-medium">{accountName}</span>
					?
				</p>
				<div className="flex items-center gap-2">
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
			<div className="space-y-1.5">
				<p className="text-xs text-destructive" title={state.message}>
					Failed to apply reset: {state.message}
				</p>
				<div className="flex items-center gap-2">
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
		<div className="space-y-1.5">
			<p
				className={`text-xs ${
					state.outcome === "reset"
						? "text-green-600 dark:text-green-400"
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
		const key = crypto.randomUUID();
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
				? " Auto-apply armed (expiry + weekly limit) — a reset will be consumed automatically shortly before expiry or when the weekly limit is hit."
				: expiryArmed
					? " Auto-apply armed — a reset will be consumed automatically shortly before expiry."
					: weeklyArmed
						? " Auto-apply armed (weekly limit) — a reset will be consumed automatically when the weekly limit is hit."
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
				<span
					className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full cursor-pointer ${colorClasses}`}
					title={`${countLabel} available.${expiryDetails}${autoApplyLine} Click for reset history.`}
				>
					<RotateCcw className="h-3.5 w-3.5" />
					{label}
				</span>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-3 space-y-3">
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
					<p className="text-xs font-medium mb-2">Usage-reset history</p>
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
 * The per-account status chip row shared by the Accounts page (`AccountListItem`)
 * and the Limits page (`AccountUtilizationCard`): Primary / priority / OAuth
 * token health, the rate-limit state, stale-lock and usage-throttle warnings,
 * the provider-overload cooldown and the peak / off-peak window. All flags come
 * from `deriveAccountStatus` so both pages stay in sync. Action buttons (e.g.
 * Force Reset) and request/session stats are intentionally left to the host.
 */
export function AccountStatusChips({
	account,
	status: providedStatus,
}: AccountStatusChipsProps) {
	const status = providedStatus ?? deriveAccountStatus(account);

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
			{status.isPrimary && (
				<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
					Primary
				</span>
			)}
			<span className="px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground rounded-full">
				Priority: {status.priority}
			</span>
			<OAuthTokenStatusWithBoundary
				accountName={account.name}
				hasRefreshToken={account.hasRefreshToken}
			/>
			{status.isRateLimited && (
				<span title="Account is rate-limited - requests will be rejected until the limit resets">
					<AlertCircle className="h-4 w-4 text-yellow-600" />
				</span>
			)}
			{status.isPaused && <span className="text-muted-foreground">Paused</span>}
			{status.isSubscriptionExpired && (
				<span
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
					title="The provider reports this account's subscription has lapsed (OAuth no longer allowed for the organization). The account was auto-paused and will auto-resume once usage data is reachable again after renewal."
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Subscription expired
				</span>
			)}
			{status.isNeedsReauth && (
				<span
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
					title="This account's OAuth refresh token was rejected (invalid_grant). It was auto-paused and removed from rotation. Re-authenticate it from the Accounts tab — it will auto-resume on success."
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Needs re-authentication
				</span>
			)}
			{status.showRateLimitChip && (
				<RateLimitStatusChip status={status.rateLimitStatus} />
			)}
			{status.staleLockDetected && (
				<span
					className="text-amber-600"
					title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
				>
					Stale lock detected
				</span>
			)}
			{status.isUsageThrottled && (
				<span
					className="text-amber-600"
					title="Usage throttling is delaying requests for this account until pacing catches up"
				>
					Usage throttled
				</span>
			)}
			{status.providerOverloadedUntil && (
				<span
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
					title={`Provider overload cooldown active until ${new Date(
						status.providerOverloadedUntil,
					).toLocaleString()}`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Provider overloaded ({status.providerOverloadMinutes}m)
				</span>
			)}
			{status.isProviderProbing && (
				<span
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
					title="Provider overload cooldown elapsed — a single probe request will test whether the upstream has recovered before traffic resumes"
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Probing recovery
				</span>
			)}
			{status.overloadedFamilies.map((entry) => (
				<span
					key={entry.family}
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
					title={`Upstream overload for the ${formatFamilyLabel(entry.family)} model family — breaker open until ${new Date(
						entry.until,
					).toLocaleString()}. Other model families keep routing to this account.`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Overloaded: {formatFamilyLabel(entry.family)} ({entry.minutes}m)
				</span>
			))}
			{status.probingFamilies.map((family) => (
				<span
					key={family}
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
					title={`${formatFamilyLabel(family)} overload cooldown elapsed — a single probe request will test whether the upstream has recovered before traffic resumes`}
				>
					<AlertCircle className="h-3.5 w-3.5" />
					Probing: {formatFamilyLabel(family)}
				</span>
			))}
			{status.isOnCredits && (
				<span
					className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
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
				</span>
			)}
			<CodexUsageResetChip account={account} status={status} />
			{status.showPeakChip && (
				<span
					className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
						status.isPeak
							? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
							: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
					}`}
				>
					<span
						className={`h-1.5 w-1.5 rounded-full ${status.isPeak ? "bg-orange-500" : "bg-green-500"}`}
					/>
					{status.peakChipLabel}
				</span>
			)}
			{status.showRenewalChip && (
				<RenewalChip account={account} status={status} />
			)}
		</div>
	);
}

const RENEWAL_URGENCY_CLASSES: Record<string, string> = {
	...URGENCY_BASE_CLASSES,
	none: "bg-secondary text-secondary-foreground",
	past: "bg-secondary text-secondary-foreground",
};

/**
 * Subscription-renewal chip. Amber when renewal is near, red when imminent,
 * muted for far-off or already-elapsed one-time dates. Only rendered when
 * `status.showRenewalChip` is true (a renewal date is set and the subscription
 * is not reported expired — see `deriveAccountStatus`).
 */
function RenewalChip({
	account,
	status,
}: {
	account: AccountResponse;
	status: AccountStatus;
}) {
	const nextDate = status.renewalNextDate;
	if (!nextDate) return null;

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

	let label: string;
	if (isPast) {
		// A past one-time date only means the configured date has elapsed — the
		// system never verifies the provider actually renewed, so don't claim
		// "Renewed". (`past` only occurs for cadence='none'; recurring cadences
		// always resolve to a future date.)
		label = `Renewal date passed (${shortDate})`;
	} else if (daysLeft === 0) {
		label = `Renews ${shortDate} (today)`;
	} else {
		label = `Renews ${shortDate} (${daysLeft}d)`;
	}

	const priceSuffix =
		account.renewalPriceUsd != null
			? ` · ${formatUsd(account.renewalPriceUsd)}/renewal`
			: "";
	const title =
		(isPast
			? `Configured one-time renewal date passed on ${isoDate}; provider renewal was not verified`
			: `Subscription renews ${isoDate} (${cadence})`) + priceSuffix;

	const colorClasses =
		RENEWAL_URGENCY_CLASSES[status.renewalUrgency] ??
		RENEWAL_URGENCY_CLASSES.none;

	return (
		<span
			className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${colorClasses}`}
			title={title}
		>
			<CalendarClock className="h-3.5 w-3.5" />
			{label}
		</span>
	);
}
