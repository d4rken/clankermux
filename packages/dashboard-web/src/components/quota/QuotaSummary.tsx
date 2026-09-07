import { Link } from "react-router";
import type { DataAvailability } from "../../lib/data-availability";
import { staleAgeLabel } from "../../lib/data-availability";
import { formatDurationDhm } from "../../lib/format-prediction";
import { type QuotaSummaryRow, usageHref } from "../../lib/quota-summary";
import { cn } from "../../lib/utils";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
} from "../ui/table";

const pct = (value: number | null) =>
	value === null ? "—" : `${Math.floor(value)}%`;
const reset = (time: number | null, now: number) =>
	time !== null && time > now ? `in ${formatDurationDhm(time - now)}` : "—";
export function QuotaAccountTable({
	row,
	now,
}: {
	row: QuotaSummaryRow;
	now: number;
}) {
	return (
		<TableFrame>
			<Table aria-label={`${row.label} accounts`}>
				<TableHeader>
					<TableRow>
						<TableHead>Account</TableHead>
						<TableHead>Weekly left</TableHead>
						<TableHead>5h left</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Weekly reset</TableHead>
						<TableHead>5h reset</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{row.accounts.map((account) => (
						<TableRow
							key={account.id}
							className={cn(!account.available && "text-muted-foreground")}
						>
							<TableCell>{account.name}</TableCell>
							<TableCell className="tabular-nums">
								{pct(account.remainingPct)}
							</TableCell>
							<TableCell className="tabular-nums">
								{pct(account.fiveHourRemainingPct)}
							</TableCell>
							<TableCell>{account.status}</TableCell>
							<TableCell>{reset(account.resetMs, now)}</TableCell>
							<TableCell>{reset(account.fiveHourResetMs, now)}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</TableFrame>
	);
}
export function QuotaSummary({
	rows,
	now,
	availability,
	selectedId,
	showBreakdown = true,
}: {
	rows: QuotaSummaryRow[];
	now: number;
	availability: DataAvailability;
	selectedId?: string;
	showBreakdown?: boolean;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Remaining quota</CardTitle>
				<CardDescription>
					Weekly budget and current availability by provider and model.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{availability.state === "loading" ? (
					<Skeleton className="h-32 w-full" />
				) : availability.state === "unavailable" ? (
					<p className="text-muted-foreground">Account data unavailable</p>
				) : rows.length === 0 ? (
					<p className="text-muted-foreground">
						No accounts configured.{" "}
						<Link to="/accounts" className="underline">
							Add an account
						</Link>
					</p>
				) : (
					<>
						<TableFrame>
							<Table aria-label="Quota by provider and model">
								<TableHeader>
									<TableRow>
										<TableHead>Provider / model</TableHead>
										<TableHead>
											<span className="hidden sm:inline">
												Average weekly remaining
											</span>
											<span className="sm:hidden">Avg weekly left</span>
										</TableHead>
										<TableHead>Available now</TableHead>
										<TableHead className="hidden md:table-cell">
											Next recovery
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((row) => (
										<TableRow
											key={row.id}
											className={cn(selectedId === row.id && "bg-muted/50")}
										>
											<TableCell
												className={cn(
													"break-words",
													row.model && "pl-5 sm:pl-8",
												)}
											>
												<Link
													to={usageHref(row)}
													className="font-medium hover:underline"
												>
													{row.label}
												</Link>
											</TableCell>
											<TableCell>
												<span
													className={cn(
														"text-xl font-semibold tabular-nums",
														row.remainingPct === null
															? "text-muted-foreground"
															: row.remainingPct === 0
																? "text-destructive"
																: "text-foreground",
													)}
												>
													{pct(row.remainingPct)}
												</span>
												{row.remainingPct === null && (
													<span className="block text-xs text-muted-foreground sm:ml-item sm:inline">
														{row.metered
															? `${row.knownCount} of ${row.accounts.length} readings`
															: "No weekly quota reported"}
													</span>
												)}
											</TableCell>
											<TableCell
												className={cn(
													row.availableCount === 0 &&
														row.unknownCount === 0 &&
														"text-warning-strong",
												)}
											>
												{row.availableCount} of {row.accounts.length}{" "}
												{row.accounts.length === 1 ? "account" : "accounts"}
												{row.recoveryMs !== null && (
													<span className="block text-xs text-muted-foreground md:hidden">
														Recovery {reset(row.recoveryMs, now)}
													</span>
												)}
												{row.unknownCount > 0 && (
													<span className="block text-xs text-muted-foreground">
														{row.unknownCount} unknown
													</span>
												)}
											</TableCell>
											<TableCell className="hidden text-muted-foreground md:table-cell">
												{reset(row.recoveryMs, now)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableFrame>
						<p className="mt-item text-xs text-muted-foreground">
							Equal weight per account; plan capacities can differ. Temporary
							blocks stay in the average. Model caps overlap the provider
							budget.
						</p>
						{showBreakdown && (
							<details className="mt-group">
								<summary className="cursor-pointer text-sm font-medium">
									Account breakdown
								</summary>
								<div className="mt-item space-y-group">
									{rows
										.filter((row) => !selectedId || row.id === selectedId)
										.map((row) => (
											<div key={row.id}>
												<p className="mb-item text-sm font-medium">
													{row.label}
												</p>
												<QuotaAccountTable row={row} now={now} />
											</div>
										))}
								</div>
							</details>
						)}
					</>
				)}
				{availability.state === "stale" && (
					<p className="mt-item text-xs text-warning-strong">
						Last updated {staleAgeLabel(availability.lastUpdatedAt, now)} ·
						refresh failed.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
