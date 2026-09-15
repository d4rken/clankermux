import { TIME_CONSTANTS } from "@clankermux/core";
import type { AccountResponse, SessionStats } from "@clankermux/types";
import { AccountPresenter } from "@clankermux/ui-common";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const ACTIVE_SESSION_WINDOW_MINUTES = Math.round(
	TIME_CONSTANTS.ACTIVE_SESSION_WINDOW_MS / 60000,
);

interface SessionCost {
	kind: "plan" | "api";
	usd: number;
}

/** Click-open detail for the compact active-session figure. */
function SessionDetailsPopover({
	stats,
	costs,
	children,
}: {
	stats: SessionStats;
	costs: readonly SessionCost[];
	children: ReactNode;
}) {
	const tokenRows = [
		["Input", stats.inputTokens],
		["Cache write", stats.cacheCreationInputTokens],
		["Cache read", stats.cacheReadInputTokens],
		["Output", stats.outputTokens],
	] as const;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="cursor-pointer text-left font-medium tabular-nums text-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					aria-label="Show active session details"
				>
					{children}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-row text-xs">
				<p className="font-medium">Active session</p>
				<p className="mt-tight text-muted-foreground">
					Usage since the current session window started.
				</p>
				<dl className="mt-row grid grid-cols-2 gap-row">
					<div>
						<dt className="text-muted-foreground">Requests</dt>
						<dd className="font-medium tabular-nums">
							{stats.requests.toLocaleString()}
						</dd>
					</div>
					{tokenRows.map(([label, value]) => (
						<div key={label}>
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="font-medium tabular-nums">
								{formatTokenCount(value)} tokens
							</dd>
						</div>
					))}
					{costs.map(({ kind, usd }) => (
						<div key={kind}>
							<dt className="capitalize text-muted-foreground">{kind} cost</dt>
							<dd className="font-medium tabular-nums">${usd.toFixed(2)}</dd>
						</div>
					))}
				</dl>
			</PopoverContent>
		</Popover>
	);
}

/**
 * What an account has been DOING: lifetime requests, how many clients touched
 * it inside the active-session window, and the current session's figure with
 * its cost segments and click-open token breakdown.
 */
export function AccountActivityStats({
	account,
}: {
	account: AccountResponse;
}) {
	const presenter = new AccountPresenter(account);
	// Spend inside the current session window. Both kinds can be non-zero at
	// once (a plan account that spilled into overage), and a zero is omitted
	// rather than rendered as "$0.00" — an unused billing mode is not news.
	const sessionCosts = account.sessionStats
		? (
				[
					{ kind: "plan", usd: account.sessionStats.planCostUsd },
					{ kind: "api", usd: account.sessionStats.apiCostUsd },
				] as const
			).filter((entry) => entry.usd > 0)
		: [];

	return (
		<div data-testid="account-activity-stats">
			<dl className="flex min-w-0 flex-wrap items-center gap-x-section gap-y-item text-xs">
				<div className="flex items-baseline gap-tight">
					<dt className="text-muted-foreground">Requests</dt>
					<dd className="font-medium tabular-nums">
						{presenter.requestCount.toLocaleString()}
					</dd>
				</div>
				{presenter.activeSessionCount > 0 && (
					<div className="flex items-baseline gap-tight">
						<dt className="text-muted-foreground">
							Clients · {ACTIVE_SESSION_WINDOW_MINUTES}m
						</dt>
						<dd className="font-medium tabular-nums">
							{presenter.activeSessionCount.toLocaleString()}
						</dd>
					</div>
				)}
				<div className="flex min-w-0 items-baseline gap-tight">
					<dt className="shrink-0 text-muted-foreground">Session</dt>
					<dd className="min-w-0">
						{account.sessionStats ? (
							<SessionDetailsPopover
								stats={account.sessionStats}
								costs={sessionCosts}
							>
								<span>{presenter.sessionInfo}</span>
								{sessionCosts.map(({ kind, usd }) => (
									<span key={kind}>
										· ${usd.toFixed(2)} {kind}
									</span>
								))}
							</SessionDetailsPopover>
						) : (
							<span className="font-medium tabular-nums">
								{presenter.sessionInfo}
							</span>
						)}
					</dd>
				</div>
			</dl>
		</div>
	);
}
