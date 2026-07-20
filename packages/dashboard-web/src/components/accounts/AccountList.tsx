import type { Account } from "../../api";
import { AccountListItem } from "./AccountListItem";

interface AccountListProps {
	accounts: Account[] | undefined;
	forcedAccountId?: string | null;
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

export function AccountList({
	accounts,
	forcedAccountId,
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
}: AccountListProps) {
	if (!accounts || accounts.length === 0) {
		return <p className="text-muted-foreground">No accounts configured</p>;
	}

	return (
		<div className="space-y-2">
			{accounts.map((account) => (
				<AccountListItem
					key={account.name}
					account={account}
					isForced={account.id === forcedAccountId}
					onForceAccount={onForceAccount}
					onPauseToggle={onPauseToggle}
					onForceResetRateLimit={onForceResetRateLimit}
					onRefreshUsage={onRefreshUsage}
					onRemove={onRemove}
					onRename={onRename}
					onPriorityChange={onPriorityChange}
					onSaveNotes={onSaveNotes}
					onRenewalChange={onRenewalChange}
					onRecordPayment={onRecordPayment}
					onResetStickiness={onResetStickiness}
					onAutoFallbackToggle={onAutoFallbackToggle}
					onAutoRefreshToggle={onAutoRefreshToggle}
					onBillingTypeToggle={onBillingTypeToggle}
					onAutoPauseOnOverageToggle={onAutoPauseOnOverageToggle}
					onPeakHoursPauseToggle={onPeakHoursPauseToggle}
					onAutoApplyResetCreditsToggle={onAutoApplyResetCreditsToggle}
					onAutoApplyResetOnWeeklyLimitToggle={
						onAutoApplyResetOnWeeklyLimitToggle
					}
					onCustomEndpointChange={onCustomEndpointChange}
					onModelMappingsChange={onModelMappingsChange}
					onReauth={onReauth}
					onAnthropicReauth={onAnthropicReauth}
					onCodexReauth={onCodexReauth}
				/>
			))}
		</div>
	);
}
