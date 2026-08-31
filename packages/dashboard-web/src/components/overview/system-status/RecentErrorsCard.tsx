import { NO_ACCOUNT_ID, type RecentErrorGroup } from "@clankermux/types";
import { useState } from "react";
import { useAccounts, useStats } from "../../../hooks/queries";
import { Button } from "../../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { ErrorDetailsModal } from "./ErrorDetailsModal";
import { otherAccountsAvailable } from "./otherAccountsAvailable";
import { RecentErrorRow } from "./RecentErrorRow";
import { useDismissedErrors } from "./useDismissedErrors";
import { type ErrorWindowKey, useErrorWindow } from "./useErrorWindow";

const WINDOW_OPTIONS: Array<{ value: ErrorWindowKey; label: string }> = [
	{ value: "1h", label: "Last hour" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "all", label: "Last year" },
];

const WINDOW_PHRASES: Record<ErrorWindowKey, string> = {
	"1h": "the last hour",
	"24h": "the last 24 hours",
	"7d": "the last 7 days",
	all: "the last year",
};

export function RecentErrorsCard() {
	const { windowKey, setWindowKey, windowHours } = useErrorWindow();
	const { data, isLoading, error } = useStats(undefined, windowHours);
	const { data: accounts } = useAccounts();
	const { dismiss, dismissMany, isDismissed } = useDismissedErrors();
	const [selectedError, setSelectedError] = useState<RecentErrorGroup | null>(
		null,
	);

	const recentErrors = data?.recentErrors;
	const visibleErrors = recentErrors?.filter((err) => !isDismissed(err)) ?? [];
	// Gated on the same conditions as the list itself. React Query keeps the
	// previous payload after a failed poll, so keying only on the length would
	// leave a Clear all button next to "Could not load recent errors", acting on
	// groups the card is no longer willing to show.
	const canDismissAll =
		!error && !(isLoading && !data) && visibleErrors.length > 0;

	const hasOtherAvailableAccounts = (errorAccountId: string | null) =>
		otherAccountsAvailable(accounts, errorAccountId);

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-group">
					<div>
						<CardTitle>Recent Errors</CardTitle>
						<CardDescription>
							Failed requests grouped by error and account.
						</CardDescription>
					</div>
					<div className="flex items-center gap-item shrink-0">
						{canDismissAll ? (
							<Button
								variant="ghost"
								size="sm"
								// Numeric padding: it has to CANCEL the `sm` variant's own
								// `px-3`, and tailwind-merge only does that against a
								// padding utility it recognises — `px-item` would leave
								// `px-3` live and change nothing.
								className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
								aria-label={`Dismiss all ${visibleErrors.length} error ${visibleErrors.length === 1 ? "group" : "groups"} in ${WINDOW_PHRASES[windowKey]}`}
								onClick={() => dismissMany(visibleErrors)}
							>
								Clear all
							</Button>
						) : null}
						<Select
							value={windowKey}
							onValueChange={(v) => setWindowKey(v as ErrorWindowKey)}
						>
							<SelectTrigger className="w-[140px] h-8 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{WINDOW_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			</CardHeader>
			<CardContent>
				{/* The card body collapses, never the card: hiding the whole thing
				    would take the window selector with it, stranding anyone who
				    dismissed everything at a narrow range with no way to widen it. */}
				{error ? (
					// Never fall through to "no errors" here: any failed poll — not just
					// the first fetch — means we don't know what the window contains right
					// now, which is the opposite claim. React Query keeps the previous
					// payload around after a later failure, so keying on the error alone
					// stops stale (possibly empty) data from being shown as current.
					<p role="alert" className="text-sm text-destructive-strong">
						Could not load recent errors.
					</p>
				) : isLoading && !data ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : visibleErrors.length === 0 ? (
					// Announced: Clear all unmounts the focused button, so without a live
					// region a screen-reader user gets no confirmation that anything
					// happened. Also covers the window selector changing the answer.
					<p role="status" className="text-sm text-muted-foreground">
						{/* "None occurred" and "all dismissed" are different situations —
						    saying "no errors" for the second one hides the fact that the
						    window still contains some. The server caps the response at 50
						    groups, so the wording avoids claiming to have seen them all. */}
						{(recentErrors?.length ?? 0) > 0
							? `Every error group returned for ${WINDOW_PHRASES[windowKey]} has been dismissed.`
							: `No errors in ${WINDOW_PHRASES[windowKey]}.`}
					</p>
				) : (
					<div className="space-y-item">
						{visibleErrors.map((error) => (
							<RecentErrorRow
								key={`${error.accountId ?? NO_ACCOUNT_ID}:${error.errorCode}:${error.latestRequestId}`}
								error={error}
								otherAccountsAvailable={hasOtherAvailableAccounts(
									error.accountId,
								)}
								onClick={() => setSelectedError(error)}
								onDismiss={() => dismiss(error)}
							/>
						))}
					</div>
				)}

				<ErrorDetailsModal
					error={selectedError}
					otherAccountsAvailable={
						selectedError
							? hasOtherAvailableAccounts(selectedError.accountId)
							: false
					}
					onClose={() => setSelectedError(null)}
					onDismiss={(group) => dismiss(group)}
				/>
			</CardContent>
		</Card>
	);
}
