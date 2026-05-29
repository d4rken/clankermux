import { AccountPresenter } from "@clankermux/ui-common";
import {
	AlertCircle,
	Edit2,
	Globe,
	Hash,
	KeyRound,
	MoreHorizontal,
	Pause,
	Play,
	RefreshCw,
	Trash2,
	Zap,
} from "lucide-react";
import { useState } from "react";
import type { Account } from "../../api";
import {
	isAnthropicPeakHour,
	isZaiPeakHour,
	providerShowsCreditsBalance,
	providerShowsWeeklyUsage,
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
import { RateLimitProgress } from "./RateLimitProgress";
import { RateLimitStatusChip } from "./RateLimitStatusChip";

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

interface AccountListItemProps {
	account: Account;
	isPrimary?: boolean;
	onPauseToggle: (account: Account) => void;
	onForceResetRateLimit: (account: Account) => void;
	onRefreshUsage: (account: Account) => Promise<void>;
	onRemove: (name: string) => void;
	onRename: (account: Account) => void;
	onPriorityChange: (account: Account) => void;
	onAutoFallbackToggle: (account: Account) => void;
	onAutoRefreshToggle: (account: Account) => void;
	onBillingTypeToggle: (account: Account) => void;
	onAutoPauseOnOverageToggle?: (account: Account) => void;
	onPeakHoursPauseToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelMappingsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
}

export function AccountListItem({
	account,
	isPrimary = false,
	onPauseToggle,
	onForceResetRateLimit,
	onRefreshUsage,
	onRemove,
	onRename,
	onPriorityChange,
	onAutoFallbackToggle,
	onAutoRefreshToggle,
	onBillingTypeToggle,
	onAutoPauseOnOverageToggle,
	onPeakHoursPauseToggle,
	onCustomEndpointChange,
	onModelMappingsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const presenter = new AccountPresenter(account);
	const now = Date.now();
	// Only hard-limit statuses mean the account is actually blocked; soft warnings
	// like "allowed_warning" / "queueing_soft" mean the account is still usable.
	const HARD_LIMIT_PREFIXES = [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	];
	const isHardLimited = HARD_LIMIT_PREFIXES.some((prefix) =>
		presenter.rateLimitStatus.toLowerCase().startsWith(prefix),
	);
	// Also show Force Reset when rate_limited_until is in the future even if
	// rate_limit_status is soft/OK — the selector still skips the account.
	const isBlockedByLegacyLock =
		typeof account.rateLimitedUntil === "number" &&
		account.rateLimitedUntil > now;
	const showForceReset =
		(isHardLimited || isBlockedByLegacyLock) && !presenter.isPaused;
	// staleLockDetected only fires when numeric usage data exists (Anthropic accounts);
	// Zai accounts have usageUtilization === null and are correctly excluded
	const staleLockDetected =
		showForceReset &&
		typeof account.usageUtilization === "number" &&
		account.usageUtilization < 100;
	const isUsageThrottled =
		typeof account.usageThrottledUntil === "number" &&
		account.usageThrottledUntil > now;
	const providerOverloadedUntil =
		typeof account.providerOverloadedUntil === "number" &&
		account.providerOverloadedUntil > now
			? account.providerOverloadedUntil
			: null;
	const providerOverloadMinutes = providerOverloadedUntil
		? Math.max(1, Math.ceil((providerOverloadedUntil - now) / 60000))
		: null;
	const hasReauth =
		(account.provider === "qwen" && !!onReauth) ||
		(account.provider === "anthropic" &&
			account.hasRefreshToken &&
			!!onAnthropicReauth) ||
		(account.provider === "codex" && !!onCodexReauth);

	// Peak/off-peak status chip (rendered inline in the status row to save a row).
	// Only zai and anthropic have peak-hour windows.
	const isZaiPeak = account.provider === "zai" && isZaiPeakHour(now);
	const isAnthropicPeak =
		account.provider === "anthropic" && isAnthropicPeakHour(now);
	const showPeakChip =
		account.provider === "zai" || account.provider === "anthropic";
	const isPeak = isZaiPeak || isAnthropicPeak;
	const peakChipLabel = isPeak
		? account.provider === "zai"
			? "Peak hours (14:00–18:00 SGT)"
			: "Peak hours (5–11am PT, weekdays)"
		: "Off-peak hours";

	// Whether the overflow menu should show the "Automation" toggle group.
	const hasAutomationToggles =
		providerSupportsAutoFeatures(account.provider) ||
		providerSupportsCustomBilling(account.provider) ||
		(account.provider === "anthropic" && !!onAutoPauseOnOverageToggle) ||
		(account.provider === "zai" && !!onPeakHoursPauseToggle);

	return (
		<div className="p-4 border rounded-lg transition-colors space-y-3 border-border hover:border-muted-foreground/50">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2 min-w-0">
					<p className="font-medium truncate">{account.name}</p>
					{isPrimary && (
						<span className="px-2 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
							Primary
						</span>
					)}
					<span className="px-2 py-0.5 text-xs font-medium bg-secondary text-secondary-foreground rounded-full">
						Priority: {account.priority}
					</span>
					<OAuthTokenStatusWithBoundary
						accountName={account.name}
						hasRefreshToken={account.hasRefreshToken}
					/>
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
									{account.provider === "anthropic" &&
										onAutoPauseOnOverageToggle && (
											<DropdownMenuCheckboxItem
												checked={account.autoPauseOnOverageEnabled ?? false}
												onCheckedChange={() =>
													onAutoPauseOnOverageToggle(account)
												}
												onSelect={(e) => e.preventDefault()}
												title="Automatically pause account when overage usage is detected. Note: detection only happens when Anthropic API reports overage, so some overage usage may occur before pausing. Account resumes when usage window resets."
											>
												Auto-pause on overage
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
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
				<span>{account.provider}</span>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
				{presenter.isRateLimited && (
					<span title="Account is rate-limited - requests will be rejected until the limit resets">
						<AlertCircle className="h-4 w-4 text-yellow-600" />
					</span>
				)}
				<span>{presenter.requestCount} requests</span>
				<span className="text-muted-foreground">{presenter.sessionInfo}</span>
				{presenter.isPaused && (
					<span className="text-muted-foreground">Paused</span>
				)}
				{!presenter.isPaused && presenter.rateLimitStatus !== "OK" && (
					<RateLimitStatusChip status={presenter.rateLimitStatus} />
				)}
				{staleLockDetected && (
					<span
						className="text-amber-600"
						title="Stale lock detected: usage data shows available capacity but account is still rate-limited"
					>
						Stale lock detected
					</span>
				)}
				{isUsageThrottled && (
					<span
						className="text-amber-600"
						title="Usage throttling is delaying requests for this account until pacing catches up"
					>
						Usage throttled
					</span>
				)}
				{providerOverloadedUntil && (
					<span
						className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
						title={`Provider overload cooldown active until ${new Date(providerOverloadedUntil).toLocaleString()}`}
					>
						<AlertCircle className="h-3.5 w-3.5" />
						Provider overloaded ({providerOverloadMinutes}m)
					</span>
				)}
				{showPeakChip && (
					<span
						className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${
							isPeak
								? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
								: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
						}`}
					>
						<span
							className={`h-1.5 w-1.5 rounded-full ${isPeak ? "bg-orange-500" : "bg-green-500"}`}
						/>
						{peakChipLabel}
					</span>
				)}
				{showForceReset && (
					<Button
						variant="outline"
						size="sm"
						className="h-7 gap-1 text-xs"
						onClick={() => onForceResetRateLimit(account)}
						title={
							staleLockDetected
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
				<div className="text-xs text-muted-foreground">
					Session: {account.sessionStats.requests} req
					{" · "}↑{formatTokenCount(account.sessionStats.inputTokens)} in
					{" · "}✦
					{formatTokenCount(account.sessionStats.cacheCreationInputTokens)}{" "}
					cache↑
					{" · "}✦{formatTokenCount(account.sessionStats.cacheReadInputTokens)}{" "}
					cache↓
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
			{(account.rateLimitReset ||
				account.usageData ||
				account.usageRateLimitedUntil ||
				providerShowsCreditsBalance(account.provider)) && (
				<RateLimitProgress
					resetIso={account.rateLimitReset}
					usageUtilization={account.usageUtilization}
					usageWindow={account.usageWindow}
					usageData={account.usageData}
					usageRateLimitedUntil={account.usageRateLimitedUntil}
					usageThrottledUntil={account.usageThrottledUntil}
					usageThrottledWindows={account.usageThrottledWindows}
					provider={account.provider}
					showWeekly={providerShowsWeeklyUsage(account.provider)}
				/>
			)}
		</div>
	);
}
