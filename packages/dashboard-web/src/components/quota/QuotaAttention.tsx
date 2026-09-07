import { Link } from "react-router";
import { useRunway } from "../../hooks/queries";
import { formatDurationDhm } from "../../lib/format-prediction";
import { type QuotaSummaryRow, usageHref } from "../../lib/quota-summary";

/** Surface service-level consequences, not every account's individual forecast. */
export function QuotaAttention({
	rows,
	now,
}: {
	rows: QuotaSummaryRow[];
	now: number;
}) {
	const query = useRunway();
	const blocked = rows.filter(
		(row) =>
			row.availableCount === 0 &&
			row.unknownCount === 0 &&
			(row.model === null ||
				rows.find(
					(parent) => parent.provider === row.provider && parent.model === null,
				)?.availableCount !== 0),
	);
	const projected = query.data?.keys
		.filter(
			(key) =>
				key.isActive &&
				key.outcome.kind === "runway" &&
				key.outcome.exhaustsAtMs > now,
		)
		.sort((a, b) =>
			a.outcome.kind === "runway" && b.outcome.kind === "runway"
				? a.outcome.exhaustsAtMs - b.outcome.exhaustsAtMs
				: 0,
		)[0];
	if (!blocked.length && !projected) return null;
	return (
		<aside
			aria-label="Quota attention"
			className="rounded-lg border p-4 space-y-item text-sm"
		>
			{blocked.map((row) => (
				<p key={row.id}>
					<Link className="font-medium underline" to={usageHref(row)}>
						{row.label}
					</Link>
					: no account currently available.
					{row.recoveryMs !== null ? (
						` Next expected recovery in ${formatDurationDhm(row.recoveryMs - now)}.`
					) : (
						<>
							{" "}
							<Link className="underline" to={`${usageHref(row)}#accounts`}>
								View account status
							</Link>
						</>
					)}
				</p>
			))}
			{projected?.outcome.kind === "runway" && (
				<p>
					{query.isError ? "Based on the last available forecast: " : ""}At this
					pace, access through {projected.keyName} may run out in{" "}
					{formatDurationDhm(projected.outcome.exhaustsAtMs - now)}.{" "}
					<Link to="/limits?forecast=1#forecast" className="underline">
						Review forecast
					</Link>
				</p>
			)}
		</aside>
	);
}
