import type { RecentErrorGroup } from "@clankermux/types";
import { NO_ACCOUNT_ID } from "@clankermux/types";
import { AlertCircle, Clock } from "lucide-react";
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
	/**
	 * The read that supplies these groups failed with nothing cached. Without
	 * this the component renders NOTHING for a failed read — visually identical
	 * to "no recent errors", which is the opposite conclusion.
	 */
	unavailable?: boolean;
	/**
	 * Set when the groups are real but the latest refresh failed. It also
	 * applies to an EMPTY list: "no errors as of a read that is now stale" is a
	 * different claim from "no errors right now".
	 */
	staleNote?: string;
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
	unavailable = false,
	staleNote,
}: CompactRecentErrorsProps) {
	const [selectedError, setSelectedError] = useState<RecentErrorGroup | null>(
		null,
	);

	if (unavailable) {
		return (
			<Card className="flex items-center gap-item px-4 py-3 text-sm text-muted-foreground">
				<AlertCircle className="h-4 w-4 shrink-0 text-warning-strong" />
				Recent errors unavailable — the stats endpoint could not be read.
			</Card>
		);
	}

	// An empty list is only silence-worthy when it is CONFIRMED empty. With a
	// stale note the same empty array means "the last response we got carried no
	// errors, and the newest poll failed" — rendering nothing would make that
	// indistinguishable from a live zero-error state.
	if (errors.length === 0 && !staleNote) return null;

	if (errors.length === 0) {
		return (
			<Card className="flex items-start gap-item px-4 py-3 text-sm">
				<Clock
					className="mt-0.5 h-4 w-4 shrink-0 text-warning-strong"
					aria-hidden="true"
				/>
				<div>
					<p className="font-medium">No errors in the last successful update</p>
					<p className="text-xs text-muted-foreground">
						The latest refresh failed, so newer errors may not be shown ·{" "}
						{staleNote}
					</p>
				</div>
			</Card>
		);
	}

	const rows = errors.slice(0, MAX_ROWS);
	const overflow = errors.length - rows.length;

	const hasOtherAvailableAccounts = (errorAccountId: string | null) =>
		otherAccountsAvailable(accounts, errorAccountId);

	return (
		<Card className="p-4 space-y-row">
			<div className="flex items-center justify-between gap-group">
				<div>
					<p className="text-sm font-medium">Recent Errors</p>
					{staleNote ? (
						// The groups are real but the latest poll failed — say how old
						// they are rather than presenting them as current.
						<p className="flex items-center gap-tight text-xs text-muted-foreground">
							<Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
							Last hour · {staleNote}
						</p>
					) : (
						<p className="text-xs text-muted-foreground">Last hour</p>
					)}
				</div>
				<Link
					to="/system"
					className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					View all →
				</Link>
			</div>

			<div className="space-y-item">
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
