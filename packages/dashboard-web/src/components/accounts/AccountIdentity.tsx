import type { Account } from "../../api";
import { cn } from "../../lib/utils";
import { InsetPanel } from "../ui/inset-panel";

/**
 * Combined plan label: Title-cased plan tier with the rate-limit multiplier
 * appended when present, e.g. plan "max" + tier "20x" → "Max 20x". When only the
 * multiplier is known (plan null), show it alone; null when neither is captured.
 */
export function formatIdentityPlanLabel(account: Account): string | null {
	const plan = account.identityPlanTier
		? account.identityPlanTier.charAt(0).toUpperCase() +
			account.identityPlanTier.slice(1)
		: null;
	const tier = account.identityRateLimitTier;
	if (plan && tier) return `${plan} ${tier}`;
	return plan ?? tier ?? null;
}

interface AccountIdentityLineProps {
	account: Account;
	className?: string;
	/**
	 * How much of the provider-side account id to show.
	 *
	 * - `"short"` (default, the accounts list): the first 8 characters, with the
	 *   full id in a `title` tooltip. Compact enough for a dense list row.
	 * - `"full"`: the whole id, no tooltip. A tooltip is unreachable by keyboard
	 *   and touch, so surfaces whose whole purpose is identifying the account
	 *   (the re-auth dialogs) spell the id out instead.
	 */
	externalIdDisplay?: "short" | "full";
}

/**
 * One muted line of provider identity for an account: email · organization ·
 * plan, followed by the provider-side account id. Absent parts are omitted, and
 * separators appear only between the parts that are actually present.
 *
 * Renders nothing when the account carries no identity at all. An external id on
 * its own IS enough to render: identity capture persists whatever single field a
 * token happened to carry, so `#a1b2c3d4` alone is a reachable state.
 */
export function AccountIdentityLine({
	account,
	className,
	externalIdDisplay = "short",
}: AccountIdentityLineProps) {
	const planLabel = formatIdentityPlanLabel(account);
	const parts = [
		account.identityEmail,
		account.identityOrganizationName,
		planLabel,
	].filter((part): part is string => Boolean(part));
	const externalId = account.identityExternalId;

	if (parts.length === 0 && !externalId) return null;

	return (
		<p
			className={cn("text-xs text-muted-foreground", className)}
			title={
				externalIdDisplay === "short" && externalId
					? `Account ID: ${externalId}`
					: undefined
			}
		>
			{parts.join(" · ")}
			{externalId && (
				// The leading margin only makes sense when something precedes the id.
				<span className={cn(parts.length > 0 && "ml-1", "opacity-60")}>
					#{externalIdDisplay === "full" ? externalId : externalId.slice(0, 8)}
				</span>
			)}
		</p>
	);
}

/**
 * The account an action is about to be applied to, shown as a self-contained
 * block: the display name over the same identity line the accounts list renders.
 *
 * Deliberately wraps rather than truncates — inside a dialog a long email or
 * organization has to stay readable, which is the whole reason this block is
 * there.
 */
export function AccountIdentityPanel({ account }: { account: Account | null }) {
	if (!account) return null;

	return (
		<InsetPanel className="min-w-0">
			<p className="text-sm font-medium break-words">{account.name}</p>
			<AccountIdentityLine
				account={account}
				className="break-words"
				externalIdDisplay="full"
			/>
		</InsetPanel>
	);
}
