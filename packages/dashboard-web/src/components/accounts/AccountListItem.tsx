import { TIME_CONSTANTS } from "@clankermux/core";
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
import { useState } from "react";
import type { Account } from "../../api";
import { deriveAccountStatus } from "../../lib/account-status";
import { hasSecondaryWeeklyWindows } from "../../lib/secondary-limits";
import {
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
	providerSupportsAutoFeatures,
	providerSupportsCustomBilling,
} from "../../utils/provider-utils";
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
import { Textarea } from "../ui/textarea";
import { AccountStatusChips } from "./AccountStatusChips";
import { ProviderChip } from "./ProviderChip";
import { RateLimitProgress } from "./RateLimitProgress";
import { useShowSecondaryLimits } from "./useShowSecondaryLimits";

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

const ACTIVE_SESSION_WINDOW_MINUTES = Math.round(
	TIME_CONSTANTS.ACTIVE_SESSION_WINDOW_MS / 60000,
);

interface AccountListItemProps {
	account: Account;
	isForced?: boolean;
	onForceAccount?: (account: Account) => void;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (name: string) => void;
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
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
}

export function AccountListItem({
	account,
	isForced = false,
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
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const [isEditingNotes, setIsEditingNotes] = useState(false);
	const [notesDraft, setNotesDraft] = useState("");
	const [isSavingNotes, setIsSavingNotes] = useState(false);
	const presenter = new AccountPresenter(account);
	// All per-account status chips — and the Force Reset gating below — are derived
	// in one place and rendered via <AccountStatusChips>; see lib/account-status.
	const status = deriveAccountStatus(account);
	// The model-specific weekly bars (e.g. a named model family like "Fable")
	// are hidden by default on the Accounts page and revealed per-account via
	// the overflow-menu toggle below. The hook is always called (Rules of
	// Hooks); the checkbox only renders when those bars exist for this account.
	const canShowSecondary = hasSecondaryWeeklyWindows(account.usageData);
	const [showSecondaryLimits, toggleSecondaryLimits] = useShowSecondaryLimits(
		account.id,
	);
	const hasReauth =
		(account.provider === "qwen" && !!onReauth) ||
		(account.provider === "anthropic" &&
			account.hasRefreshToken &&
			!!onAnthropicReauth) ||
		(account.provider === "codex" && !!onCodexReauth);

	// Whether the overflow menu should show the "Automation" toggle group.
	const hasAutomationToggles =
		providerSupportsAutoFeatures(account.provider) ||
		providerSupportsCustomBilling(account.provider) ||
		((account.provider === "anthropic" || account.provider === "codex") &&
			!!onAutoPauseOnOverageToggle) ||
		(account.provider === "zai" && !!onPeakHoursPauseToggle) ||
		(account.provider === "codex" &&
			(!!onAutoApplyResetCreditsToggle ||
				!!onAutoApplyResetOnWeeklyLimitToggle));

	return (
		<div className="p-4 border rounded-lg transition-colors space-y-3 border-border hover:border-muted-foreground/50">
			<div className="flex items-center justify-between">
				<div className="flex flex-col min-w-0">
					<div className="flex items-center gap-2 min-w-0">
						<p className="font-medium truncate">{account.name}</p>
						<ProviderChip provider={account.provider} className="shrink-0" />
					</div>
					{(account.identityEmail ||
						account.identityOrganizationName ||
						account.identityPlanTier) && (
						<p
							className="text-xs text-muted-foreground truncate"
							title={
								account.identityExternalId
									? `Account ID: ${account.identityExternalId}`
									: undefined
							}
						>
							{[
								account.identityEmail,
								account.identityOrganizationName,
								account.identityPlanTier
									? account.identityPlanTier.charAt(0).toUpperCase() +
										account.identityPlanTier.slice(1)
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
							{account.identityExternalId && (
								<span className="ml-1 opacity-60">
									#{account.identityExternalId.slice(0, 8)}
								</span>
							)}
						</p>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					{(account.provider === "anthropic" ||
						account.provider === "codex") && (
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-1 text-xs"
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
								account.provider === "codex"
									? "Refresh usage data (sends one minimal Codex request — consumes a small slice of quota)"
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
							className={isForced ? "text-destructive bg-destructive/10" : ""}
							onClick={() => onForceAccount(account)}
							title={
								isForced
									? "Forcing all traffic here — click to release"
									: "Force all traffic to this account"
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
									{providerSupportsAutoFeatures(account.provider) && (
										<>
											<DropdownMenuCheckboxItem
												checked={account.autoFallbackEnabled}
												onCheckedChange={() => onAutoFallbackToggle(account)}
												onSelect={(e) => e.preventDefault()}
												title="Automatically switch back to this account from lower-priority ones when its rate limit resets. Requires multiple accounts with different priorities."
											>
												Auto-fallback
											</DropdownMenuCheckboxItem>
											<DropdownMenuCheckboxItem
												checked={account.autoRefreshEnabled}
												onCheckedChange={() => onAutoRefreshToggle(account)}
												onSelect={(e) => e.preventDefault()}
												title="Automatically sends a minimal message when the usage window resets to avoid cold-start latency. Does not affect OAuth token refreshing."
											>
												Auto-refresh
											</DropdownMenuCheckboxItem>
										</>
									)}
									{providerSupportsCustomBilling(account.provider) && (
										<DropdownMenuCheckboxItem
											checked={account.billingType === "plan"}
											onCheckedChange={() => onBillingTypeToggle(account)}
											onSelect={(e) => e.preventDefault()}
											title="Toggle plan billing for this account"
										>
											Plan billing
										</DropdownMenuCheckboxItem>
									)}
									{(account.provider === "anthropic" ||
										account.provider === "codex") &&
										onAutoPauseOnOverageToggle && (
											<DropdownMenuCheckboxItem
												// Inverted polarity: this reads as an "allow extra spend"
												// toggle. Checked = allowed to spend extra (NOT protected);
												// the default (unchecked) means protected / no extra cost.
												// The handler flips the stored protected flag, so the
												// rendered `checked` is the negation of it.
												checked={!account.autoPauseOnOverageEnabled}
												onCheckedChange={() =>
													onAutoPauseOnOverageToggle(account)
												}
												onSelect={(e) => e.preventDefault()}
												title={
													account.provider === "codex"
														? "When the weekly Codex limit is reached, allow this account to keep running on purchased credits. When OFF (default), the account pauses and traffic fails over to other accounts, then auto-resumes when the weekly window resets."
														: "Allow this account to incur overage charges past its plan limit. When OFF (default), the account auto-pauses when overage usage is detected and resumes when the usage window resets. Note: detection relies on Anthropic reporting overage, so some overage may occur before pausing."
												}
											>
												{account.provider === "codex"
													? "Allow credits past weekly limit"
													: "Allow overage spend"}
											</DropdownMenuCheckboxItem>
										)}
									{account.provider === "zai" && onPeakHoursPauseToggle && (
										<DropdownMenuCheckboxItem
											checked={account.peakHoursPauseEnabled ?? false}
											onCheckedChange={() => onPeakHoursPauseToggle(account)}
											onSelect={(e) => e.preventDefault()}
											title="Automatically pause this account during Zai peak hours (14:00–18:00 SGT)"
										>
											Peak hours pause
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
												title="Automatically consume a banked usage reset shortly (~10 min) before it expires so it isn't wasted. Applies even while paused, unless the account needs re-authentication."
											>
												Auto-apply expiring usage resets
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
												title="Automatically consume a banked usage reset when this account's weekly usage reaches 100%. At most one auto-apply per hour."
											>
												Auto-apply reset at weekly limit
											</DropdownMenuCheckboxItem>
										)}
									<DropdownMenuSeparator />
								</>
							)}
							{canShowSecondary && (
								<>
									<DropdownMenuLabel>Display</DropdownMenuLabel>
									<DropdownMenuCheckboxItem
										checked={showSecondaryLimits}
										onCheckedChange={toggleSecondaryLimits}
										onSelect={(e) => e.preventDefault()}
										title="Show the per-model weekly limits in addition to the 5-hour and overall weekly limits."
									>
										Show secondary limits
									</DropdownMenuCheckboxItem>
									<DropdownMenuSeparator />
								</>
							)}
							<DropdownMenuItem onClick={() => onRename(account)}>
								<Edit2 className="mr-2 h-4 w-4" />
								Rename
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => onPriorityChange(account)}>
								<Zap className="mr-2 h-4 w-4" />
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
									className={`mr-2 h-4 w-4 ${account.renewalAnchor ? "text-primary" : ""}`}
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
								<Receipt className="mr-2 h-4 w-4" />
								Record Payment…
							</DropdownMenuItem>
							{onResetStickiness && (
								<DropdownMenuItem
									onClick={() => onResetStickiness(account)}
									title="Clear this account's session affinity pins and active-session anchor so its sessions re-pick on their next request"
								>
									<Unlink className="mr-2 h-4 w-4" />
									Reset session stickiness
								</DropdownMenuItem>
							)}
							{(onCustomEndpointChange || onModelMappingsChange) && (
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
										className={`mr-2 h-4 w-4 ${account.customEndpoint ? "text-primary" : ""}`}
									/>
									Custom Endpoint
									{account.customEndpoint && (
										<span className="ml-auto text-xs text-muted-foreground">
											set
										</span>
									)}
								</DropdownMenuItem>
							)}
							{onModelMappingsChange && (
								<DropdownMenuItem
									onClick={() => onModelMappingsChange(account)}
									title={
										account.modelMappings
											? `Model mappings configured (${Object.keys(account.modelMappings).length} mappings)`
											: "Configure model mappings"
									}
								>
									<Hash
										className={`mr-2 h-4 w-4 ${account.modelMappings ? "text-primary" : ""}`}
									/>
									Model Mappings
									{account.modelMappings && (
										<span className="ml-auto text-xs text-muted-foreground">
											{Object.keys(account.modelMappings).length}
										</span>
									)}
								</DropdownMenuItem>
							)}
							{hasReauth && <DropdownMenuSeparator />}
							{account.provider === "qwen" && onReauth && (
								<DropdownMenuItem
									onClick={() => onReauth(account)}
									title="Re-authenticate this Qwen account (preserves all metadata)"
								>
									<KeyRound className="mr-2 h-4 w-4" />
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
										<KeyRound className="mr-2 h-4 w-4" />
										Re-authenticate
									</DropdownMenuItem>
								)}
							{account.provider === "codex" && onCodexReauth && (
								<DropdownMenuItem
									onClick={() => onCodexReauth(account)}
									title="Re-authenticate this Codex account (preserves all metadata)"
								>
									<KeyRound className="mr-2 h-4 w-4" />
									Re-authenticate
								</DropdownMenuItem>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onRemove(account.name)}
					>
						<Trash2 className="h-4 w-4" />
					</Button>
				</div>
			</div>
			{isEditingNotes ? (
				<div className="space-y-2">
					<Textarea
						value={notesDraft}
						onChange={(e) => setNotesDraft(e.target.value)}
						placeholder="Add a note for this account…"
						disabled={isSavingNotes}
						autoFocus
					/>
					<div className="flex items-center gap-2">
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
				<div className="flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
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
			) : (
				<Button
					variant="ghost"
					size="sm"
					className="h-6 gap-1 px-1 text-xs text-muted-foreground"
					title="Add a note for this account"
					onClick={() => {
						setNotesDraft("");
						setIsEditingNotes(true);
					}}
				>
					<StickyNote className="h-3.5 w-3.5" />
					Add note
				</Button>
			)}
			<AccountStatusChips account={account} status={status} />
			<div className="space-y-1">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
					<span>{presenter.requestCount} requests</span>
					{presenter.activeSessionCount > 0 && (
						<span className="text-muted-foreground">
							· {presenter.activeSessionCount} clients (
							{ACTIVE_SESSION_WINDOW_MINUTES}m)
						</span>
					)}
					<span className="text-muted-foreground">{presenter.sessionInfo}</span>
					{status.showForceReset && (
						<Button
							variant="outline"
							size="sm"
							className="h-7 gap-1 text-xs"
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
				{account.sessionStats && (
					<div className="text-sm text-muted-foreground">
						Session: {account.sessionStats.requests} req
						{" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
						{" · "}✦
						{formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
						cache↑
						{" · "}✦
						{formatTokenCount(account.sessionStats.cacheReadInputTokens)} cache↓
						{" · "}↓{formatTokenCount(account.sessionStats.outputTokens)} out
						{account.sessionStats.planCostUsd > 0 && (
							<>
								{" · "}${account.sessionStats.planCostUsd.toFixed(2)} plan
							</>
						)}
						{account.sessionStats.apiCostUsd > 0 && (
							<>
								{" · "}${account.sessionStats.apiCostUsd.toFixed(2)} api
							</>
						)}
					</div>
				)}
			</div>
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
					usageRateLimitedUntil={account.usageRateLimitedUntil}
					usageThrottledUntil={account.usageThrottledUntil}
					usageThrottledWindows={account.usageThrottledWindows}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
					showSecondaryWeekly={showSecondaryLimits}
					prediction={account.prediction}
				/>
			)}
		</div>
	);
}
