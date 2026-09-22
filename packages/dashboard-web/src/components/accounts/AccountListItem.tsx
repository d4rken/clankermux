import type { LiveScopedFamily } from "@clankermux/core";
import type { DegradedAccount } from "@clankermux/types";
import {
	supportsCustomEndpoint,
	supportsUsagePolling,
} from "@clankermux/types";
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
	Power,
	Receipt,
	RefreshCw,
	StickyNote,
	Trash2,
	Unlink,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Textarea } from "../ui/textarea";
import { AccountAccessNotice } from "./AccountAccessNotice";
import { AccountIdentityLine } from "./AccountIdentity";
import {
	AccountPausedChip,
	AccountRenewalInfo,
	AccountRoutingChips,
	AccountStatusChips,
} from "./AccountStatusChips";
import { OpenRouterAccountDetails } from "./OpenRouterAccountDetails";
import { ProviderChip } from "./ProviderChip";
import { RateLimitProgress } from "./RateLimitProgress";

interface AccountListItemProps {
	account: Account;
	isForced?: boolean;
	/**
	 * This account's substitution entry, when a provider is currently answering
	 * it with a different model. Threaded from the list so one query serves
	 * every row rather than one per row.
	 */
	degraded?: DegradedAccount;
	// Per-window-category reset endpoints across the whole list; forwarded to the
	// rate-limit card so it can distinguish the first and last capacity returns.
	earliestResets?: ReadonlyMap<string, number>;
	latestResets?: ReadonlyMap<string, number>;
	// Families some unpaused account in THIS account's servable class reports;
	// forwarded to the rate-limit card, which renders any of them this account
	// has not used this week as a labelled row instead of omitting it.
	poolScopedFamilies?: readonly LiveScopedFamily[];
	onForceAccount?: (account: Account) => void;
	onDisabledToggle?: (account: Account) => void;
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
	onAutoApplyBankedResetsToggle?: (account: Account) => void;
	onAutoApplyBankedResetOnWeeklyLimitToggle?: (account: Account) => void;
	onCustomEndpointChange?: (account: Account) => void;
	onModelPermissionsChange?: (account: Account) => void;
	onReauth?: (account: Account) => void;
	onAnthropicReauth?: (account: Account) => void;
	onCodexReauth?: (account: Account) => void;
	onDevinReauth?: (account: Account) => void;
	onZaiReauth?: (account: Account) => void;
	onGrokSubscriptionReauth?: (account: Account) => void;
}

/**
 * What the menu says about where the anchor came from. "set" means a human
 * confirmed this date, so a provider-reported one must not borrow the word.
 */
const RENEWAL_SOURCE_LABEL: Record<"manual" | "derived" | "provider", string> =
	{
		manual: "set",
		derived: "estimated",
		provider: "from provider",
	};

const RENEWAL_SOURCE_TITLE: Record<"manual" | "derived" | "provider", string> =
	{
		manual: "",
		derived: " — estimated from the subscription start",
		provider: " — the period end the provider reported",
	};

export function AccountListItem({
	account,
	isForced = false,
	degraded,
	earliestResets,
	latestResets,
	poolScopedFamilies,
	onForceAccount,
	onPauseToggle,
	onDisabledToggle,
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
	onAutoApplyBankedResetsToggle,
	onAutoApplyBankedResetOnWeeklyLimitToggle,
	onCustomEndpointChange,
	onModelPermissionsChange,
	onReauth,
	onAnthropicReauth,
	onCodexReauth,
	onDevinReauth,
	onZaiReauth,
	onGrokSubscriptionReauth,
}: AccountListItemProps) {
	const [isRefreshingUsage, setIsRefreshingUsage] = useState(false);
	const handleRefreshUsage = async () => {
		setIsRefreshingUsage(true);
		try {
			await onRefreshUsage(account);
		} finally {
			setIsRefreshingUsage(false);
		}
	};
	const [isEditingNotes, setIsEditingNotes] = useState(false);
	const [notesDraft, setNotesDraft] = useState("");
	const [isSavingNotes, setIsSavingNotes] = useState(false);
	const notesRef = useRef<HTMLTextAreaElement>(null);
	// Set when the note editor is opened FROM the overflow menu. Radix restores
	// focus to the menu trigger when the menu closes, which happens after the
	// editor has mounted and taken focus — so without suppressing that restore
	// the caret lands back on the "…" button and the first keystroke is lost.
	const notesOpenedFromMenu = useRef(false);

	/** Focus the note editor with the caret after any existing text. */
	const focusNotesEditor = useCallback(() => {
		const field = notesRef.current;
		if (!field) return;
		field.focus();
		field.setSelectionRange(field.value.length, field.value.length);
	}, []);

	const startEditingNotes = (initial: string, fromMenu: boolean) => {
		setNotesDraft(initial);
		setIsEditingNotes(true);
		notesOpenedFromMenu.current = fromMenu;
	};

	// Covers the pencil button, where nothing competes for focus. The menu path
	// needs `onCloseAutoFocus` below as well: this effect runs while the menu is
	// still closing, so its focus restore would land after it.
	useEffect(() => {
		if (isEditingNotes) focusNotesEditor();
	}, [isEditingNotes, focusNotesEditor]);

	// Header details, status chips and Force Reset gating share derived status.
	const status = deriveAccountStatus(account);
	// zai, minimax and ollama-cloud pin their endpoint in the provider, so
	// offering the control would let an operator set something that is stored,
	// badged here, and then ignored on every request.
	const endpointIsConfigurable = supportsCustomEndpoint(account.provider);
	const hasReauth =
		(account.provider === "qwen" && !!onReauth) ||
		(account.provider === "anthropic" &&
			account.hasRefreshToken &&
			!!onAnthropicReauth) ||
		(account.provider === "codex" && !!onCodexReauth) ||
		(account.provider === "devin" && !!onDevinReauth) ||
		(account.provider === "zai" && !!onZaiReauth) ||
		(account.provider === "grok-subscription" && !!onGrokSubscriptionReauth);

	// Menu copy for one automation flag. Sourced from the shared descriptors the
	// policy chips render from, so an item's label and explanation cannot drift
	// from the chip that reports the same flag's state two rows below.
	const policyCopy = (key: AccountPolicyKey) =>
		describeAccountPolicy(key, account.provider);

	// Banked resets are claimed with the account's OAuth token.
	const hasBankedResets =
		account.provider === "anthropic" && account.hasRefreshToken;

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
				!!onAutoApplyResetOnWeeklyLimitToggle)) ||
		(hasBankedResets &&
			(!!onAutoApplyBankedResetsToggle ||
				!!onAutoApplyBankedResetOnWeeklyLimitToggle));

	// Three groups, and the rhythm has to say so: identity, status, quota.
	// `space-y-row` between them, tighter steps inside each. A single
	// `space-y-item` for everything gave the name→email pair — which is one
	// group — exactly as much air as the boundary between two, so six of these
	// cards read as one wall of text.
	return (
		<div className="p-group border rounded-lg transition-colors space-y-row border-border hover:border-muted-foreground/50">
			<div className="flex items-start justify-between gap-item">
				<div className="flex flex-col gap-tight min-w-0">
					<div
						className="flex flex-wrap items-center gap-x-item gap-y-tight min-w-0"
						data-testid="account-heading-row"
					>
						<p className="font-medium max-w-full truncate">{account.name}</p>
						<ProviderChip provider={account.provider} className="shrink-0" />
						{account.disabled ? (
							<span className="text-xs text-muted-foreground">Disabled</span>
						) : (
							<>
								<OAuthTokenStatusWithBoundary
									accountName={account.name}
									hasRefreshToken={account.hasRefreshToken}
								/>
								<AccountPausedChip account={account} status={status} />
								<AccountRoutingChips status={status} />
							</>
						)}
					</div>
					<AccountIdentityLine
						account={account}
						className="break-words"
						details={
							!account.disabled && status.showRenewalChip ? (
								<AccountRenewalInfo account={account} status={status} inline />
							) : undefined
						}
					/>
				</div>
				<div
					data-testid="account-actions"
					className="flex flex-wrap items-center justify-end gap-tight shrink-0 max-w-[50%]"
				>
					{(supportsUsagePolling(account.provider) ||
						account.provider === "codex" ||
						(account.provider === "openrouter" && !account.customEndpoint)) && (
						<Button
							variant="ghost"
							size="sm"
							className="h-8 gap-tight text-xs"
							disabled={account.disabled || isRefreshingUsage}
							onClick={handleRefreshUsage}
							title={
								account.provider === "devin"
									? "Refresh Devin account and usage metadata (does not consume inference quota)"
									: account.provider === "openrouter"
										? "Refresh OpenRouter account details and usage"
										: account.provider === "codex"
											? "Refresh usage data (free usage read — does not consume quota)"
											: account.provider === "anthropic"
												? "Refresh usage data (restarts usage polling and refreshes token if expired)"
												: // API-key providers have no token to refresh.
													"Refresh usage data (restarts usage polling)"
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
						disabled={account.disabled}
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
							disabled={account.disabled}
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
						<DropdownMenuContent
							align="end"
							onCloseAutoFocus={(event) => {
								if (!notesOpenedFromMenu.current) return;
								notesOpenedFromMenu.current = false;
								event.preventDefault();
								focusNotesEditor();
							}}
						>
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
									{hasBankedResets && onAutoApplyBankedResetsToggle && (
										<DropdownMenuCheckboxItem
											checked={account.autoApplyBankedResetsEnabled ?? false}
											onCheckedChange={() =>
												onAutoApplyBankedResetsToggle(account)
											}
											onSelect={(e) => e.preventDefault()}
											title={policyCopy("autoApplyExpiry").description}
										>
											{policyCopy("autoApplyExpiry").menuLabel}
										</DropdownMenuCheckboxItem>
									)}
									{hasBankedResets &&
										onAutoApplyBankedResetOnWeeklyLimitToggle && (
											<DropdownMenuCheckboxItem
												checked={
													account.autoApplyBankedResetOnWeeklyLimitEnabled ??
													false
												}
												onCheckedChange={() =>
													onAutoApplyBankedResetOnWeeklyLimitToggle(account)
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
									onClick={() => startEditingNotes("", true)}
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
										? `Renewal date: ${account.renewalAnchor} (${account.renewalCadence ?? "none"})${RENEWAL_SOURCE_TITLE[account.renewalAnchorSource ?? "manual"]}`
										: "Set subscription renewal date"
								}
							>
								<CalendarClock
									className={`mr-item h-4 w-4 ${account.renewalAnchor ? "text-primary" : ""}`}
								/>
								Set Renewal Date
								{account.renewalAnchor && (
									<span className="ml-auto text-xs text-muted-foreground">
										{
											RENEWAL_SOURCE_LABEL[
												account.renewalAnchorSource ?? "manual"
											]
										}
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
							{((onCustomEndpointChange && endpointIsConfigurable) ||
								onModelPermissionsChange) && <DropdownMenuSeparator />}
							{onCustomEndpointChange && endpointIsConfigurable && (
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
							{account.provider === "zai" && onZaiReauth && (
								<DropdownMenuItem
									onClick={() => onZaiReauth(account)}
									title="Reconnect this z.ai account (preserves all metadata)"
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
							{account.provider === "grok-subscription" &&
								onGrokSubscriptionReauth && (
									<DropdownMenuItem
										onClick={() => onGrokSubscriptionReauth(account)}
										title="Re-authenticate this Grok account (preserves all metadata)"
									>
										<KeyRound className="mr-item h-4 w-4" />
										Re-authenticate
									</DropdownMenuItem>
								)}
							<DropdownMenuSeparator />
							{onDisabledToggle && (
								<DropdownMenuItem
									onClick={() => onDisabledToggle(account)}
									title={
										account.disabled
											? "Enable account and recheck access"
											: "Disable account: stop gateway activity and exclude from current statistics"
									}
								>
									<Power className="mr-item h-4 w-4" />
									{account.disabled ? "Enable Account" : "Disable Account"}
								</DropdownMenuItem>
							)}
							<DropdownMenuItem
								onClick={() => onRemove(account)}
								className="text-destructive-strong focus:bg-destructive/10 focus:text-destructive-strong"
								title="Delete this account and everything stored for it"
							>
								<Trash2 className="mr-item h-4 w-4" />
								Delete Account
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					{status.showForceReset && (
						// The one labelled button among ghost icons, so it keeps the
						// outline that tells it apart. It is also the widest, so at ~400px
						// it would otherwise squeeze the account name beside it toward
						// nothing. The strip's `max-w-[50%]` is what makes its `flex-wrap`
						// effective: a `shrink-0` strip with no maximum width sizes to its
						// single-line max-content width, so nothing ever forces a second
						// line and the name absorbs the whole overflow.
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
			</div>
			{isEditingNotes ? (
				<div className="space-y-item">
					<Textarea
						ref={notesRef}
						value={notesDraft}
						onChange={(e) => setNotesDraft(e.target.value)}
						placeholder="Add a note for this account…"
						disabled={isSavingNotes}
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
						onClick={() => startEditingNotes(account.notes ?? "", false)}
					>
						<Edit2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			) : null}
			{/* Status flags: their own group, a step away from the identity above
			    and the quota bars below. */}
			{!account.disabled && (
				<>
					<AccountStatusChips
						account={account}
						status={status}
						showAccountDetails={false}
						degraded={degraded}
					/>
					<AccountAccessNotice
						account={account}
						isChecking={isRefreshingUsage}
						onRecheck={handleRefreshUsage}
					/>
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
				</>
			)}
		</div>
	);
}
