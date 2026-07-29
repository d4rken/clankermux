import type { RecentErrorGroup } from "@clankermux/types";
import { NO_ACCOUNT_ID } from "@clankermux/types";
import { useState } from "react";
import { Link } from "react-router";
import { Card } from "../../ui/card";
import { ErrorDetailsModal } from "./ErrorDetailsModal";
import {
	type AccountForFailoverCheck,
	otherAccountsAvailable,
} from "./otherAccountsAvailable";
import { RecentErrorRow } from "./RecentErrorRow";

/** Rows shown before deferring to the full list on /system. */
const MAX_ROWS = 3;

interface CompactRecentErrorsProps {
	/**
	 * Already-filtered visible groups (see `useVisibleRecentErrors`), newest
	 * first — that's the order `/api/stats` returns them in.
	 */
	errors: RecentErrorGroup[];
	accounts: AccountForFailoverCheck[] | undefined;
	onDismiss: (group: RecentErrorGroup) => void;
}

/**
 * Overview's trimmed error list: the newest few groups from the last hour, no
 * window selector. The full list — with the persisted 1h/24h/7d/year range —
 * lives on /system.
 *
 * Kept a sibling of the health strip rather than nested inside it: the dismiss
 * control is a real <button>, which would be invalid markup inside the strip's
 * <Link> (the same constraint RecentErrorRow already documents).
 */
export function CompactRecentErrors({
	errors,
	accounts,
	onDismiss,
}: CompactRecentErrorsProps) {
	const [selectedError, setSelectedError] = useState<RecentErrorGroup | null>(
		null,
	);

	if (errors.length === 0) return null;

	const rows = errors.slice(0, MAX_ROWS);
	const overflow = errors.length - rows.length;

	const hasOtherAvailableAccounts = (errorAccountId: string | null) =>
		otherAccountsAvailable(accounts, errorAccountId);

	return (
		<Card className="p-4 space-y-3">
			<div className="flex items-center justify-between gap-4">
				<div>
					<p className="text-sm font-medium">Recent Errors</p>
					<p className="text-xs text-muted-foreground">Last hour</p>
				</div>
				<Link
					to="/system"
					className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					View all →
				</Link>
			</div>

			<div className="space-y-2">
				{rows.map((error) => (
					<RecentErrorRow
						key={`${error.accountId ?? NO_ACCOUNT_ID}:${error.errorCode}:${error.latestRequestId}`}
						error={error}
						otherAccountsAvailable={hasOtherAvailableAccounts(error.accountId)}
						onClick={() => setSelectedError(error)}
						onDismiss={() => onDismiss(error)}
					/>
				))}
			</div>

			{overflow > 0 ? (
				<p className="text-xs text-muted-foreground">
					+{overflow} more error {overflow === 1 ? "group" : "groups"} in the
					last hour
				</p>
			) : null}

			<ErrorDetailsModal
				error={selectedError}
				otherAccountsAvailable={
					selectedError
						? hasOtherAvailableAccounts(selectedError.accountId)
						: false
				}
				onClose={() => setSelectedError(null)}
				onDismiss={(group) => onDismiss(group)}
			/>
		</Card>
	);
}
