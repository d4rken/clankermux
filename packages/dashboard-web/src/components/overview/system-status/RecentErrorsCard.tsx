import { NO_ACCOUNT_ID, type RecentErrorGroup } from "@clankermux/types";
import { useState } from "react";
import { useAccounts, useStats } from "../../../hooks/queries";
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
	const { dismiss, isDismissed } = useDismissedErrors();
	const [selectedError, setSelectedError] = useState<RecentErrorGroup | null>(
		null,
	);

	const recentErrors = data?.recentErrors;
	const visibleErrors = recentErrors?.filter((err) => !isDismissed(err)) ?? [];

	const hasOtherAvailableAccounts = (errorAccountId: string | null) =>
		otherAccountsAvailable(accounts, errorAccountId);

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-4">
					<div>
						<CardTitle>Recent Errors</CardTitle>
						<CardDescription>
							Failed requests grouped by error and account.
						</CardDescription>
					</div>
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
					<p role="alert" className="text-sm text-destructive">
						Could not load recent errors.
					</p>
				) : isLoading && !data ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : visibleErrors.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{/* "None occurred" and "all dismissed" are different situations —
						    saying "no errors" for the second one hides the fact that the
						    window still contains some. The server caps the response at 50
						    groups, so the wording avoids claiming to have seen them all. */}
						{(recentErrors?.length ?? 0) > 0
							? `Every error group returned for ${WINDOW_PHRASES[windowKey]} has been dismissed.`
							: `No errors in ${WINDOW_PHRASES[windowKey]}.`}
					</p>
				) : (
					<div className="space-y-2">
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
