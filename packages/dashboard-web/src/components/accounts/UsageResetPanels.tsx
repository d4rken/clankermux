import type { ReactNode } from "react";
import {
	formatResetTime,
	type ResetCreditUrgency,
} from "../../lib/account-status";
import { Button } from "../ui/button";

// Popover pieces shared by the banked usage-reset chips of every provider
// (Codex reset credits, Anthropic banked resets). Pure and state-in, so each
// step renders with static markup in tests.

/**
 * Shared amber/red urgency palette for time-pressure chips — spread into both
 * the reset chips' and the renewal chip's class maps so they stay in sync.
 */
export const URGENCY_BASE_CLASSES = {
	imminent: "bg-destructive/15 text-destructive-strong",
	soon: "bg-warning/15 text-warning-strong",
} as const;

/**
 * Chip color by reset urgency — same amber/red Tailwind palette as the
 * renewal chip, sky when nothing expires soon.
 */
export const RESET_CREDIT_URGENCY_CLASSES: Record<ResetCreditUrgency, string> =
	{
		...URGENCY_BASE_CLASSES,
		none: "bg-info/15 text-info",
	};

/**
 * The chip text of every provider's reset chip: `3 resets · expires Jan 5`.
 * "expires" stays in the label: a bare date beside a countdown chip reads as
 * a reset time, which is the opposite of what it marks.
 */
export function usageResetChipLabel(
	count: number,
	nextExpiry: Date | null,
): string {
	const countLabel = `${count} reset${count === 1 ? "" : "s"}`;
	const shortExpiry = nextExpiry?.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	return shortExpiry ? `${countLabel} · expires ${shortExpiry}` : countLabel;
}

/** Lazy-load lifecycle of a reset-event history in a popover. */
export type ResetEventsState<E> =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "loaded"; events: E[] };

/** The fields every provider's reset ledger event carries. */
export interface ResetEventBase {
	id: string;
	trigger: "manual" | "auto";
	cause: "expiry" | "weekly-limit" | null;
	errorMessage: string | null;
	createdAt: string;
}

/** Cap on the inline error text per event row; full message stays in `title`. */
const MAX_EVENT_ERROR_CHARS = 120;

/** Human label for why an auto reset attempt was claimed. */
const RESET_EVENT_CAUSE_LABELS: Record<
	NonNullable<ResetEventBase["cause"]>,
	string
> = {
	expiry: "expiry",
	"weekly-limit": "weekly limit",
};

export function ResetEventsPanel<E extends ResetEventBase>({
	state,
	statusLabel,
	detail,
}: {
	state: ResetEventsState<E>;
	statusLabel: (event: E) => string;
	/** Muted text after the status label, e.g. "2 windows reset". */
	detail: (event: E) => string | null;
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
			{state.events.map((event) => {
				const eventDetail = detail(event);
				return (
					<li key={event.id} className="text-xs space-y-tight">
						<div className="flex flex-wrap items-center gap-item">
							<span className="text-muted-foreground whitespace-nowrap">
								{formatResetTime(event.createdAt)}
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
							<span className="font-medium">{statusLabel(event)}</span>
							{eventDetail && (
								<span className="text-muted-foreground">{eventDetail}</span>
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
				);
			})}
		</ul>
	);
}

/**
 * Lifecycle of a manual "Apply now" flow. The request's idempotency key is not
 * part of it: the chip holds the key so a retry can reuse it.
 */
export type ResetApplyState =
	| { kind: "idle" }
	| { kind: "confirm" }
	| { kind: "applying" }
	| { kind: "done"; success: boolean; message: string }
	/**
	 * Not settled: Retry resends the same attempt. `detail` is the tooltip;
	 * Retry stays disabled until `retryAt` (ms epoch) when one is given.
	 */
	| { kind: "retry"; message: string; detail?: string; retryAt?: number };

export function ResetApplyConfirmPanel({
	available,
	state,
	armTitle,
	confirmPrompt,
	onArm,
	onConfirm,
	onCancel,
	onRetry,
	onDismiss,
	now = Date.now(),
}: {
	/** Whether a reset can be applied right now; gates the idle button only. */
	available: boolean;
	state: ResetApplyState;
	armTitle: string;
	confirmPrompt: ReactNode;
	onArm: () => void;
	onConfirm: () => void;
	onCancel: () => void;
	onRetry: () => void;
	/** Dismiss a terminal outcome — the parent resets the flow back to idle. */
	onDismiss: () => void;
	/** Render time; the parent re-renders when `retryAt` passes. */
	now?: number;
}) {
	if (state.kind === "idle") {
		if (!available) return null;
		return (
			<Button
				variant="outline"
				size="sm"
				className="h-7 text-xs"
				onClick={onArm}
				title={armTitle}
			>
				Apply now
			</Button>
		);
	}
	if (state.kind === "confirm") {
		return (
			<div className="space-y-item">
				<p className="text-xs">{confirmPrompt}</p>
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
	if (state.kind === "retry") {
		const waiting = state.retryAt !== undefined && state.retryAt > now;
		return (
			<div className="space-y-item">
				<p
					className="text-xs text-destructive-strong"
					title={state.detail ?? state.message}
				>
					{state.message}
				</p>
				<div className="flex items-center gap-item">
					<Button
						size="sm"
						className="h-7 text-xs"
						onClick={onRetry}
						disabled={waiting}
						title={
							waiting && state.retryAt !== undefined
								? `Retry after ${formatResetTime(new Date(state.retryAt).toISOString())}`
								: undefined
						}
					>
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
					state.success ? "text-success-strong" : "text-muted-foreground"
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
