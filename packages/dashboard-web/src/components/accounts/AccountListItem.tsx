import { type LiveScopedFamily, TIME_CONSTANTS } from "@clankermux/core";
import type { SessionStats } from "@clankermux/types";
import { AccountPresenter } from "@clankermux/ui-common";
import {
	CalendarClock,
	Crosshair,
	Edit2,
	Globe,
	Hash,
	KeyRound,
	MoreHorizontal,
	Pause,
	Play,
	Receipt,
	RefreshCw,
	StickyNote,
	Trash2,
	Unlink,
	Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Account } from "../../api";
import {
	type AccountPolicyKey,
	describeAccountPolicy,
} from "../../lib/account-policies";
import { deriveAccountStatus } from "../../lib/account-status";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
	providerSupportsAutoFallback,
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../../utils/provider-utils";
import { OAuthTokenStatusWithBoundary } from "../OAuthTokenStatus";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { InsetPanel } from "../ui/inset-panel";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { AccountIdentityLine } from "./AccountIdentity";
import {
	AccountRenewalInfo,
	AccountRoutingChips,
	AccountStatusChips,
} from "./AccountStatusChips";
import { OpenRouterAccountDetails } from "./OpenRouterAccountDetails";
import { ProviderChip } from "./ProviderChip";
import { RateLimitProgress } from "./RateLimitProgress";

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

interface AccountListItemProps {
	account: Account;
	isForced?: boolean;
	// Per-window-category reset endpoints across the whole list; forwarded to the
	// rate-limit card so it can distinguish the first and last capacity returns.
	earliestResets?: ReadonlyMap<string, number>;
	latestResets?: ReadonlyMap<string, number>;
	// Families some unpaused account in THIS account's servable class reports;
	// forwarded to the rate-limit card, which renders any of them this account
	// has not used this week as a labelled row instead of omitting it.
	poolScopedFamilies?: readonly LiveScopedFamily[];
	onForceAccount?: (account: Account) => void;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (account: Account) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onSaveNotes: (account: Account, notes: string | null) => void | Promise<void>;
	onRenewalChange: (account: Account) => void;
	onRecordPayment: (account: Account) => void;
	onResetStickiness?: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onAutoApplyResetCreditsToggle?: (account: Account) => void;
	onAutoApplyResetOnWeeklyLimitToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelPermissionsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
	onDevinReauth?: (account: Account) => void;
}

export function AccountListItem({
	account,
	isForced = false,
	earliestResets,
	latestResets,
	poolScopedFamilies,
	onForceAccount,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onSaveNotes,
	onRenewalChange,
	onRecordPayment,
	onResetStickiness,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onPeakHoursPauseToggle,
	onAutoApplyResetCreditsToggle,
	onAutoApplyResetOnWeeklyLimitToggle,
	onCustomEndpointChange,
	onModelPermissionsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
	onDevinReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const [isEditingNotes, setIsEditingNotes] = useState(false);
	const [notesDraft, setNotesDraft] = useState("");
	const [isSavingNotes, setIsSavingNotes] = useState(false);
	const presenter = new AccountPresenter(account);
	// Header details, status chips and Force Reset gating share derived status.
	const status = deriveAccountStatus(account);
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
	const hasReauth =
		(account.provider === "qwen" && !!onReauth) ||
		(account.provider === "anthropic" &&
			account.hasRefreshToken &&
			!!onAnthropicReauth) ||
		(account.provider === "codex" && !!onCodexReauth) ||
		(account.provider === "devin" && !!onDevinReauth);

	// Menu copy for one automation flag. Sourced from the shared descriptors the
	// policy chips render from, so an item's label and explanation cannot drift
	// from the chip that reports the same flag's state two rows below.
	const policyCopy = (key: AccountPolicyKey) =>
		describeAccountPolicy(key, account.provider);

	// Whether the overflow menu should show the "Automation" toggle group.
	const hasAutomationToggles =
		providerSupportsAutoFallback(account.provider) ||
		providerSupportsCustomBilling(account.provider) ||
		((account.provider === "anthropic" ||
			account.provider === "codex" ||
			account.provider === "devin") &&
			!!onAutoPauseOnOverageToggle) ||
		(account.provider === "zai" && !!onPeakHoursPauseToggle) ||
		(account.provider === "codex" &&
			(!!onAutoApplyResetCreditsToggle ||
				!!onAutoApplyResetOnWeeklyLimitToggle));

	// Four groups, and the rhythm has to say so: identity, status, counts, quota.
	// `space-y-row` between them, tighter steps inside each. A single
	// `space-y-item` for everything gave the name→email pair — which is one
	// group — exactly as much air as the boundary between two, so six of these
	// cards read as one wall of text.
	return (
		<div className="p-group border rounded-lg transition-colors space-y-row border-border hover:border-muted-foreground/50">
			<div className="flex items-start justify-between gap-item">
				<div className="flex flex-col gap-tight min-w-0">
					<div className="flex flex-wrap items-center gap-x-item gap-y-tight min-w-0">
						<p className="font-medium max-w-full truncate">{account.name}</p>
						<ProviderChip provider={account.provider} className="shrink-0" />
						<OAuthTokenStatusWithBoundary
							accountName={account.name}
							hasRefreshToken={account.hasRefreshToken}
						/>
						<AccountRoutingChips status={status} />
					</div>
					<AccountIdentityLine
						account={account}
						className="break-words"
						details={
							status.showRenewalChip ? (
								<AccountRenewalInfo account={account} status={status} inline />
							) : undefined
						}
					/>
				</div>
				<div className="flex items-center gap-tight shrink-0">
					{(account.provider === "anthropic" ||
						account.provider === "codex" ||
						account.provider === "devin" ||
						(account.provider === "openrouter" && !account.customEndpoint)) && (
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-tight text-xs"
							disabled={isRefreshingUsage}
							onClick={async () => {
								setIsRefreshingUsage(true);
								try {
									await onRefreshUsage(account);
								} finally {
									setIsRefreshingUsage(false);
								}
							}}
							title={
								account.provider === "devin"
									? "Refresh Devin account and usage metadata (does not consume inference quota)"
									: account.provider === "openrouter"
										? "Refresh OpenRouter account details and usage"
										: account.provider === "codex"
											? "Refresh usage data (free usage read — does not consume quota)"
											: "Refresh usage data (restarts usage polling and refreshes token if expired)"
							}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${isRefreshingUsage ? "animate-spin" : ""}`}
							/>
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onPauseToggle(account)}
						title={account.paused ? "Resume account" : "Pause account"}
					>
						{account.paused ? (
							<Play className="h-4 w-4" />
						) : (
							<Pause className="h-4 w-4" />
						)}
					</Button>
					{onForceAccount && (
						<Button
							variant="ghost"
							size="sm"
							className={
								isForced ? "text-destructive-strong bg-destructive/10" : ""
							}
							onClick={() => onForceAccount(account)}
							title={
								isForced
									? "Restricting requests to this destination — click to release"
									: "Restrict requests to this account"
							}
						>
							<Crosshair className="h-4 w-4" />
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="sm" title="More actions">
								<MoreHorizontal className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							{hasAutomationToggles && (
								<>
									<DropdownMenuLabel>Automation</DropdownMenuLabel>
									{providerSupportsAutoFallback(account.provider) && (
										<DropdownMenuCheckboxItem
											checked={account.autoFallbackEnabled}
											onCheckedChange={() => onAutoFallbackToggle(account)}
											onSelect={(e) => e.preventDefault()}
											title={policyCopy("autoFallback").description}
										>
											{policyCopy("autoFallback").menuLabel}
										</DropdownMenuCheckboxItem>
									)}
									{providerSupportsAutoFeatures(account.provider) && (
										<DropdownMenuCheckboxItem
											checked={account.autoRefreshEnabled}
											onCheckedChange={() => onAutoRefreshToggle(account)}
											onSelect={(e) => e.preventDefault()}
											title={policyCopy("autoRefresh").description}
										>
											{policyCopy("autoRefresh").menuLabel}
										</DropdownMenuCheckboxItem>
									)}
									{providerSupportsCustomBilling(account.provider) && (
										<DropdownMenuCheckboxItem
											checked={account.billingType === "plan"}
											onCheckedChange={() => onBillingTypeToggle(account)}
											onSelect={(e) => e.preventDefault()}
											title={policyCopy("planBilling").description}
										>
											{policyCopy("planBilling").menuLabel}
										</DropdownMenuCheckboxItem>
									)}
									{(account.provider === "anthropic" ||
										account.provider === "codex" ||
										account.provider === "devin") &&
										onAutoPauseOnOverageToggle && (
											<DropdownMenuCheckboxItem
												// Inverted polarity: this reads as an "allow extra spend"
												// toggle. Checked = allowed to spend extra (NOT protected);
												// the default (unchecked) means protected / no extra cost.
												// The handler flips the stored protected flag, so the
												// rendered `checked` is the negation of it.
												checked={
													account.provider === "devin"
														? account.autoPauseOnOverageEnabled === false
														: !account.autoPauseOnOverageEnabled
												}
												onCheckedChange={() =>
													onAutoPauseOnOverageToggle(account)
												}
												onSelect={(e) => e.preventDefault()}
												title={policyCopy("extraSpend").description}
											>
												{policyCopy("extraSpend").menuLabel}
											</DropdownMenuCheckboxItem>
										)}
									{account.provider === "zai" && onPeakHoursPauseToggle && (
										<DropdownMenuCheckboxItem
											checked={account.peakHoursPauseEnabled ?? false}
											onCheckedChange={() => onPeakHoursPauseToggle(account)}
											onSelect={(e) => e.preventDefault()}
											title={policyCopy("peakHoursPause").description}
										>
											{policyCopy("peakHoursPause").menuLabel}
										</DropdownMenuCheckboxItem>
									)}
									{account.provider === "codex" &&
										onAutoApplyResetCreditsToggle && (
											<DropdownMenuCheckboxItem
												checked={account.autoApplyResetCreditsEnabled ?? false}
												onCheckedChange={() =>
													onAutoApplyResetCreditsToggle(account)
												}
												onSelect={(e) => e.preventDefault()}
												title={policyCopy("autoApplyExpiry").description}
											>
												{policyCopy("autoApplyExpiry").menuLabel}
											</DropdownMenuCheckboxItem>
										)}
									{account.provider === "codex" &&
										onAutoApplyResetOnWeeklyLimitToggle && (
											<DropdownMenuCheckboxItem
												checked={
													account.autoApplyResetOnWeeklyLimitEnabled ?? false
												}
												onCheckedChange={() =>
													onAutoApplyResetOnWeeklyLimitToggle(account)
												}
												onSelect={(e) => e.preventDefault()}
												title={policyCopy("autoApplyWeekly").description}
											>
												{policyCopy("autoApplyWeekly").menuLabel}
											</DropdownMenuCheckboxItem>
										)}
									<DropdownMenuSeparator />
								</>
							)}
							{!account.notes && (
								<DropdownMenuItem
									onClick={() => {
										setNotesDraft("");
										setIsEditingNotes(true);
									}}
									title="Add a note for this account"
								>
									<StickyNote className="mr-item h-4 w-4" />
									Add note
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onClick={() => onRename(account)}>
								<Edit2 className="mr-item h-4 w-4" />
								Rename
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onPriorityChange(account)}>
								<Zap className="mr-item h-4 w-4" />
								Change Priority
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => onRenewalChange(account)}
								title={
									account.renewalAnchor
										? `Renewal date: ${account.renewalAnchor} (${account.renewalCadence ?? "none"})`
										: "Set subscription renewal date"
								}
							>
								<CalendarClock
									className={`mr-item h-4 w-4 ${account.renewalAnchor ? "text-primary" : ""}`}
								/>
								Set Renewal Date
								{account.renewalAnchor && (
									<span className="ml-auto text-xs text-muted-foreground">
										set
									</span>
								)}
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() => onRecordPayment(account)}
								title="Record a manual payment (subscription renewal or usage-credit purchase) in the ledger"
							>
								<Receipt className="mr-item h-4 w-4" />
								Record Payment…
							</DropdownMenuItem>
							{onResetStickiness && (
								<DropdownMenuItem
									onClick={() => onResetStickiness(account)}
									title="Clear this account's session affinity pins and active-session anchor so its sessions re-pick on their next request"
								>
									<Unlink className="mr-item h-4 w-4" />
									Reset session stickiness
								</DropdownMenuItem>
							)}
							{(onCustomEndpointChange || onModelPermissionsChange) && (
								<DropdownMenuSeparator />
							)}
							{onCustomEndpointChange && (
								<DropdownMenuItem
									onClick={() => onCustomEndpointChange(account)}
									title={
										account.customEndpoint
											? `Custom endpoint: ${account.customEndpoint}`
											: "Set custom endpoint"
									}
								>
									<Globe
										className={`mr-item h-4 w-4 ${account.customEndpoint ? "text-primary" : ""}`}
									/>
									Custom Endpoint
									{account.customEndpoint && (
										<span className="ml-auto text-xs text-muted-foreground">
											set
										</span>
									)}
								</DropdownMenuItem>
							)}
							{onModelPermissionsChange && (
								<DropdownMenuItem
									onClick={() => onModelPermissionsChange(account)}
									title="Manage permitted models"
								>
									<Hash className="mr-item h-4 w-4" />
									Permitted Models
								</DropdownMenuItem>
							)}
							{hasReauth && <DropdownMenuSeparator />}
							{account.provider === "qwen" && onReauth && (
								<DropdownMenuItem
									onClick={() => onReauth(account)}
									title="Re-authenticate this Qwen account (preserves all metadata)"
								>
									<KeyRound className="mr-item h-4 w-4" />
									Re-authenticate
								</DropdownMenuItem>
							)}
							{account.provider === "anthropic" &&
								account.hasRefreshToken &&
								onAnthropicReauth && (
									<DropdownMenuItem
										onClick={() => onAnthropicReauth(account)}
										title="Re-authenticate this Anthropic account (preserves all metadata)"
									>
										<KeyRound className="mr-item h-4 w-4" />
										Re-authenticate
									</DropdownMenuItem>
								)}
							{account.provider === "devin" && onDevinReauth && (
								<DropdownMenuItem
									onClick={() => onDevinReauth(account)}
									title="Reconnect this Devin account (preserves all metadata)"
								>
									<KeyRound className="mr-item h-4 w-4" />
									Reconnect
								</DropdownMenuItem>
							)}
							{account.provider === "codex" && onCodexReauth && (
								<DropdownMenuItem
									onClick={() => onCodexReauth(account)}
									title="Re-authenticate this Codex account (preserves all metadata)"
								>
									<KeyRound className="mr-item h-4 w-4" />
									Re-authenticate
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button variant="ghost" size="sm" onClick={() => onRemove(account)}>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>
			{isEditingNotes ? (
				<div className="space-y-item">
					<Textarea
						value={notesDraft}
						onChange={(e) => setNotesDraft(e.target.value)}
						placeholder="Add a note for this account…"
						disabled={isSavingNotes}
						autoFocus
					/>
					<div className="flex items-center gap-item">
						<Button
							size="sm"
							disabled={isSavingNotes}
							onClick={async () => {
								setIsSavingNotes(true);
								try {
									await onSaveNotes(account, notesDraft.trim() || null);
									setIsEditingNotes(false);
								} catch {
									// Save failed; keep the editor open with the draft
									// intact. The error is surfaced by the parent handler.
								} finally {
									setIsSavingNotes(false);
								}
							}}
						>
							Save
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={isSavingNotes}
							onClick={() => setIsEditingNotes(false)}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : account.notes ? (
				<div className="flex items-center gap-item text-sm text-muted-foreground min-w-0">
					<StickyNote className="h-3.5 w-3.5 shrink-0" />
					<span className="truncate" title={account.notes}>
						{account.notes.split("\n")[0]}
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 w-6 p-0 shrink-0"
						title="Edit note"
						onClick={() => {
							setNotesDraft(account.notes ?? "");
							setIsEditingNotes(true);
						}}
					>
						<Edit2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			) : null}
			{/* Status flags and the counts they qualify: one group, so they sit a
			    step closer to each other than to the identity above or the quota
			    bars below. */}
			<div className="space-y-item">
				<AccountStatusChips
					account={account}
					status={status}
					showAccountDetails={false}
				/>
				<InsetPanel data-testid="account-info-row">
					<div className="flex flex-wrap items-center gap-row">
						<dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-section gap-y-item text-xs">
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
							{status.reauthDeadlineMs !== null && (
								// Always shown once known, not only inside the warning window: the
								// point of capturing the deadline is that it stops being a
								// surprise, and a date that only appears in its final week is
								// still a surprise for the other eleven.
								<div
									className="flex items-baseline gap-tight"
									title="When this account's OAuth refresh token expires. Rotating tokens does not extend it — the account auto-pauses and needs a manual re-auth once it passes."
								>
									<dt className="text-muted-foreground">Re-auth by</dt>
									<dd className="font-medium tabular-nums">
										{new Date(status.reauthDeadlineMs).toLocaleDateString(
											undefined,
											{
												year: "numeric",
												month: "short",
												day: "numeric",
											},
										)}
									</dd>
								</div>
							)}
						</dl>
						{status.showForceReset && (
							<Button
								variant="outline"
								size="sm"
								className="h-7 gap-tight text-xs"
								onClick={() => onForceResetRateLimit(account)}
								title={
									status.staleLockDetected
										? "Reset stale rate limit lock (usage shows capacity available)"
										: "Force clear rate limit state from database"
								}
							>
								<RefreshCw className="h-3.5 w-3.5" />
								Force Reset
							</Button>
						)}
					</div>
				</InsetPanel>
			</div>
			{account.provider === "openrouter" && !account.customEndpoint && (
				<OpenRouterAccountDetails metadata={account.openRouterMetadata} />
			)}
			{(account.rateLimitReset ||
				account.usageData ||
				account.staleUsage ||
				account.usageRateLimitedUntil ||
				providerShowsCreditsBalance(account.provider)) && (
				<RateLimitProgress
					resetIso={account.rateLimitReset}
					usageUtilization={account.usageUtilization}
					usageWindow={account.usageWindow}
					usageData={account.usageData}
					staleUsage={account.staleUsage}
					usageAsOfIso={account.usageAsOfIso}
					usageRateLimitedUntil={account.usageRateLimitedUntil}
					usageThrottledUntil={account.usageThrottledUntil}
					usageThrottledWindows={account.usageThrottledWindows}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
					prediction={account.prediction}
					burnAnchors={account.burnAnchors}
					earliestResets={earliestResets}
					latestResets={latestResets}
					poolScopedFamilies={poolScopedFamilies}
					compact
				/>
			)}
		</div>
	);
}
