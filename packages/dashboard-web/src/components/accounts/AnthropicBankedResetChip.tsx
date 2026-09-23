import { HttpError } from "@clankermux/http-common";
import type {
	AccountResponse,
	AnthropicBankedResetEventResponse,
	AnthropicBankedResetsInfo,
} from "@clankermux/types";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { type AccountStatus, formatResetTime } from "../../lib/account-status";
import {
	type AnthropicBankedResetGrantInfo,
	bankedResetClearsLabels,
	bankedResetEventDetail,
	bankedResetEventStatusLabel,
	bankedResetRetryState,
	claimableBankedResetGrant,
	describeBankedResetClaim,
	findResumableBankedResetClaim,
	formatBankedResetReason,
	pendingBankedResetClaimOf,
	retryAtOf,
	showsAnthropicBankedResetChip,
	unconfirmedBankedResetMessage,
} from "../../lib/anthropic-banked-resets";
import { randomUUID } from "../../lib/uuid";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { StatusChip } from "./StatusChip";
import {
	applyResetFailedMessage,
	bankedResetAutoApplySentence,
	bankedResetExpirySentence,
	bankedResetsLeftSentence,
	RESET_CREDIT_URGENCY_CLASSES,
	ResetApplyConfirmPanel,
	type ResetApplyState,
	ResetEventsPanel,
	type ResetEventsState,
	usageResetChipLabel,
} from "./UsageResetPanels";

/** Completes "the next banked reset is applied …" in the chip tooltip. */
const ANTHROPIC_WEEKLY_RULE =
	"at a weekly limit it clears when no other Claude account can serve and the account's natural weekly reset is at least 12 hours away, or when it would expire before that limit lifts";

/**
 * Claim rejections the same request can never turn around: bad input, a
 * missing account, a disabled account or a request id bound to another grant.
 */
const TERMINAL_CLAIM_HTTP_STATUSES = new Set([400, 404, 409]);

/**
 * The manual claim in progress. `requestId` is generated once per armed
 * attempt and reused by every retry until the claim settles or its replay
 * window closes at `replayUntil` (ms epoch), so the server deduplicates a
 * retried POST that had already landed.
 */
interface ClaimAttempt {
	state: ResetApplyState;
	requestId: string | null;
	grantId: string | null;
	replayUntil: number | null;
}

const IDLE_ATTEMPT: ClaimAttempt = {
	state: { kind: "idle" },
	requestId: null,
	grantId: null,
	replayUntil: null,
};

function GrantRow({ grant }: { grant: AnthropicBankedResetGrantInfo }) {
	const clears = bankedResetClearsLabels(grant.clears);
	const details = [
		clears.length > 0 ? `clears ${clears.join(", ")}` : null,
		grant.endsAt ? `use by ${formatResetTime(grant.endsAt)}` : null,
		grant.useRequiresLimit ? "usable at a limit" : "usable anytime",
	].filter((part): part is string => part !== null);
	return (
		<li className="text-xs space-y-tight">
			<div className="flex flex-wrap items-center gap-item">
				<span className="font-medium">{grant.label || "Reset"}</span>
				<span className="tabular-nums">
					{grant.resetsLeft}/{grant.resetsTotal}
				</span>
				{/* `px-1.5` matches the history rows' micro-pills. */}
				{grant.isNext && (
					<span className="px-1.5 py-0 rounded-md label-caps bg-info/15 text-info">
						next
					</span>
				)}
				{grant.paused && (
					<span className="px-1.5 py-0 rounded-md label-caps bg-warning/15 text-warning-strong">
						paused
					</span>
				)}
			</div>
			<p className="text-muted-foreground">{details.join(" · ")}</p>
		</li>
	);
}

/**
 * The popover's grant list and the account-level state behind it. Exported
 * (pure, state-in) so it renders with static markup in tests.
 */
export function BankedResetGrantsPanel({
	info,
	now = Date.now(),
}: {
	info: AnthropicBankedResetsInfo;
	now?: number;
}) {
	const cooldownUntil =
		info.cooldownUntil && Date.parse(info.cooldownUntil) > now
			? info.cooldownUntil
			: null;
	const atLimit = bankedResetClearsLabels(info.exhausted);
	const accountLines = [
		info.eligible
			? null
			: `Not eligible${info.ineligibleReason ? ` (${formatBankedResetReason(info.ineligibleReason)})` : ""}`,
		cooldownUntil
			? `Cooling down until ${formatResetTime(cooldownUntil)}`
			: null,
		atLimit.length > 0 ? `At a limit: ${atLimit.join(", ")}` : null,
	].filter((line): line is string => line !== null);
	return (
		<div className="space-y-item">
			<p className="text-xs font-medium">Banked resets</p>
			<ul className="space-y-item">
				{info.grants.map((grant) => (
					<GrantRow key={grant.id} grant={grant} />
				))}
			</ul>
			{accountLines.map((line) => (
				<p key={line} className="text-xs text-muted-foreground">
					{line}
				</p>
			))}
		</div>
	);
}

/**
 * Anthropic banked resets (Claude Code's `cedar_ember` program): resets left
 * across the account's grants, colored by the soonest use-by date, with the
 * grants, a manual claim of the next one and the claim history in a popover.
 */
export function AnthropicBankedResetChip({
	account,
	status,
}: {
	account: AccountResponse;
	status: AccountStatus;
}) {
	const [eventsState, setEventsState] = useState<
		ResetEventsState<AnthropicBankedResetEventResponse>
	>({ kind: "idle" });
	const [attempt, setAttempt] = useState<ClaimAttempt>(IDLE_ATTEMPT);
	// Re-render once a held Retry becomes available, and once it lapses.
	const [, setRetryTick] = useState(0);
	const retryAt =
		attempt.state.kind === "retry" ? attempt.state.retryAt : undefined;
	const replayUntil =
		attempt.state.kind === "retry" ? attempt.replayUntil : null;
	useEffect(() => {
		const now = Date.now();
		const timers = [retryAt, replayUntil ?? undefined]
			.filter((at): at is number => at !== undefined && at > now)
			.map((at) =>
				setTimeout(() => setRetryTick((tick) => tick + 1), at - now + 50),
			);
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [retryAt, replayUntil]);
	const shownState = bankedResetRetryState(
		attempt.state,
		attempt.replayUntil,
		Date.now(),
	);
	const info = account.anthropicBankedResets;
	if (!info || !showsAnthropicBankedResetChip(account)) return null;

	const grantIds = info.grants.map((grant) => grant.id);
	const loadEvents = () => {
		setEventsState({ kind: "loading" });
		api
			.getAccountBankedResetEvents(account.id, 20)
			.then((events) => {
				setEventsState({ kind: "loaded", events });
				// After a reload the only copy of an unconfirmed manual claim's
				// request id is its ledger row; the server refuses any other
				// claim on the account until it is retried or expires.
				const pending = findResumableBankedResetClaim(events, grantIds);
				if (!pending) return;
				setAttempt((prev) =>
					prev.state.kind === "idle"
						? {
								state: {
									kind: "retry",
									message: unconfirmedBankedResetMessage(pending.nextAttemptAt),
									...retryAtOf(pending.nextAttemptAt),
								},
								requestId: pending.requestId,
								grantId: pending.grantId,
								replayUntil: pending.replayUntil,
							}
						: prev,
				);
			})
			.catch((error: unknown) =>
				setEventsState({
					kind: "error",
					message: error instanceof Error ? error.message : String(error),
				}),
			);
	};

	const runClaim = (
		requestId: string,
		grantId: string,
		replayUntil: number | null,
	) => {
		setAttempt({
			state: { kind: "applying" },
			requestId,
			grantId,
			replayUntil,
		});
		api
			.claimAccountBankedReset(account.id, { grantId, requestId })
			.then((response) => {
				const view = describeBankedResetClaim(response);
				setAttempt(
					view.kind === "retry"
						? {
								state: view,
								requestId,
								grantId,
								replayUntil: view.replayUntil ?? replayUntil,
							}
						: { ...IDLE_ATTEMPT, state: view },
				);
				loadEvents();
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				const pending = pendingBankedResetClaimOf(error);
				if (pending) {
					setAttempt({
						state: {
							kind: "retry",
							message: "Earlier attempt unconfirmed — retry it",
							detail: message,
						},
						requestId: pending.requestId,
						grantId: pending.grantId,
						replayUntil: pending.replayUntil,
					});
					return;
				}
				if (
					error instanceof HttpError &&
					TERMINAL_CLAIM_HTTP_STATUSES.has(error.status)
				) {
					setAttempt({
						...IDLE_ATTEMPT,
						state: { kind: "done", success: false, message },
					});
					return;
				}
				// Unknown whether the POST landed: keep the request id for Retry.
				setAttempt({
					state: {
						kind: "retry",
						message: applyResetFailedMessage(message),
						detail: message,
					},
					requestId,
					grantId,
					replayUntil,
				});
			});
	};

	const claimable = claimableBankedResetGrant(info);
	const handleArm = () => {
		if (!claimable) return;
		setAttempt({
			state: { kind: "confirm" },
			requestId: randomUUID(),
			grantId: claimable.id,
			replayUntil: null,
		});
	};
	const handleConfirmOrRetry = () => {
		if (shownState.kind === "done") return;
		if (attempt.requestId && attempt.grantId) {
			runClaim(attempt.requestId, attempt.grantId, attempt.replayUntil);
		}
	};
	const handleCancel = () => setAttempt(IDLE_ATTEMPT);

	const handleOpenChange = (open: boolean) => {
		if (open && eventsState.kind === "idle") loadEvents();
		// A terminal outcome from a previous visit is stale on reopen.
		if (open && shownState.kind === "done") handleCancel();
	};

	const left = info.resetsLeftTotal;
	const nextExpiry = status.bankedResetNextExpiry;
	const title = `${bankedResetsLeftSentence(left)}${bankedResetExpirySentence(
		status.bankedResetExpiries,
	)}${bankedResetAutoApplySentence({
		count: left,
		expiryArmed: status.bankedResetAutoApplyArmed,
		weeklyArmed: status.bankedResetAutoApplyOnWeeklyLimitArmed,
		weeklyRule: ANTHROPIC_WEEKLY_RULE,
	})} Click for banked resets and history.`;
	const colorClasses =
		left > 0
			? RESET_CREDIT_URGENCY_CLASSES[status.bankedResetUrgency]
			: "bg-secondary text-muted-foreground";

	const claimGrant = info.grants.find((grant) => grant.id === attempt.grantId);

	return (
		<Popover onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<StatusChip className={`cursor-pointer ${colorClasses}`} title={title}>
					<RotateCcw className="h-3.5 w-3.5" />
					{usageResetChipLabel(left, nextExpiry)}
				</StatusChip>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-row space-y-row">
				<ResetApplyConfirmPanel
					available={claimable !== null}
					state={shownState}
					confirmPrompt={
						<>
							Use 1 reset from {claimGrant?.label || "the next grant"} for{" "}
							<span className="font-medium">{account.name}</span>?
						</>
					}
					onArm={handleArm}
					onConfirm={handleConfirmOrRetry}
					onCancel={handleCancel}
					onRetry={handleConfirmOrRetry}
					onDismiss={handleCancel}
				/>
				<BankedResetGrantsPanel info={info} />
				<ResetEventsPanel
					state={eventsState}
					statusLabel={(event) => bankedResetEventStatusLabel(event, grantIds)}
					detail={bankedResetEventDetail}
				/>
			</PopoverContent>
		</Popover>
	);
}
