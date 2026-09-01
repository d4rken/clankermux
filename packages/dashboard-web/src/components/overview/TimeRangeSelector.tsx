import { Clock } from "lucide-react";
import type { TimeRange } from "../../constants";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

/**
 * The app's one range picker.
 *
 * There used to be two — this one and an inline `Select` inside
 * `AnalyticsControls` — offering identical range values and differing only in
 * icon, label casing and width, so the control changed appearance and position
 * as you walked across the analytics tabs. `AnalyticsControls` now renders
 * this one.
 *
 * `value`/`onChange` are the shared `TimeRange` union rather than `string`:
 * under `strictFunctionTypes` a `(r: TimeRange) => void` is not assignable to
 * a `(value: string) => void` parameter, so a `string`-typed picker forced
 * every union-typed caller to cast at the boundary. The single remaining cast
 * is the one below, where Radix's `onValueChange` hands back a bare string —
 * that is the boundary the union is established at, not one the callers repeat.
 */
interface TimeRangeSelectorProps {
	value: TimeRange;
	onChange: (value: TimeRange) => void;
	ariaLabel?: string;
}

const RANGE_OPTIONS: ReadonlyArray<{ value: TimeRange; label: string }> = [
	{ value: "1h", label: "Last hour" },
	{ value: "6h", label: "Last 6 hours" },
	{ value: "24h", label: "Last 24 hours" },
	{ value: "7d", label: "Last 7 days" },
	{ value: "30d", label: "Last 30 days" },
	{ value: "all", label: "All time" },
];

export function TimeRangeSelector({
	value,
	onChange,
	ariaLabel,
}: TimeRangeSelectorProps) {
	return (
		<div className="flex items-center gap-item">
			<Clock className="h-4 w-4 text-muted-foreground" />
			<Select value={value} onValueChange={(v) => onChange(v as TimeRange)}>
				<SelectTrigger className="w-[150px]" aria-label={ariaLabel}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{RANGE_OPTIONS.map((range) => (
						<SelectItem key={range.value} value={range.value}>
							{range.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
