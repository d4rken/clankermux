import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * The settings page's one layout primitive.
 *
 * Before this existed each card invented its own arrangement — label beside the
 * control in one, above it in another, a fixed `w-28` label here and a `w-12`
 * there — so nothing lined up between cards and the Save buttons sat at a
 * different x on every row because they trailed a variable-width unit word
 * ("hours" vs "GB" vs "days"). Every setting is the same four things, so they
 * get one grid:
 *
 *   label │ control          ← the only row that is always present
 *         │ value            ← a measurement or derived preview, when there is one
 *         │ summary ⌄        ← one line, always readable
 *         │ detail           ← the long rationale, behind the expander
 *
 * The label column is a fixed track, so a label that wraps to two lines pushes
 * nothing sideways, and value/summary/detail all share the control's left edge:
 * everything about a setting hangs off one vertical line.
 */
export interface SettingRowProps {
	label: ReactNode;
	/** The input, select or switch this row configures. */
	control: ReactNode;
	/** A measured or derived figure belonging to this setting. */
	value?: ReactNode;
	/** One line, always visible. Keep it to a single sentence. */
	summary?: ReactNode;
	/** Long-form rationale, collapsed behind the summary's expander. */
	detail?: ReactNode;
	className?: string;
}

export function SettingRow({
	label,
	control,
	value,
	summary,
	detail,
	className,
}: SettingRowProps) {
	return (
		// A CONTAINER query, not a viewport one. These rows sit in cards that are
		// half-width at one breakpoint and full-width at another, and the retention
		// card splits its own settings into two columns again — so viewport width
		// says nothing useful about the space a given row actually has. Keyed on
		// `sm:` (viewport) the two tracks switched on at 640px while the row itself
		// still only had ~340px, and the Save button overflowed its card.
		//
		// The outer element is the container and the inner grid queries it, so the
		// breakpoint is encapsulated here rather than at every call site.
		<div className={cn("@container", className)}>
			<div className="grid grid-cols-1 gap-x-item gap-y-tight @md:grid-cols-[9.5rem_minmax(0,1fr)]">
				{/* 9.5rem label + ~236px control cluster ≈ 400px, so the two-track
				    layout needs @md (448px) to fit with room to spare. Below that
				    the label sits above its control instead. */}
				<span className="text-sm font-medium leading-tight @md:pt-1.5">
					{label}
				</span>
				<div className="min-w-0">{control}</div>
				{value != null && (
					<div className="min-w-0 @md:col-start-2">{value}</div>
				)}
				{(summary != null || detail != null) && (
					<div className="min-w-0 @md:col-start-2">
						<SettingNote summary={summary} detail={detail} />
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * The summary line, plus its expander when there is long-form detail.
 *
 * A native `<details>` rather than state + a button: it is keyboard operable and
 * correctly announced with no work, and it still renders open-able markup under
 * `renderToStaticMarkup`, which is how the settings cards are tested.
 */
function SettingNote({
	summary,
	detail,
}: {
	summary?: ReactNode;
	detail?: ReactNode;
}) {
	if (detail == null) {
		return (
			<p className="text-xs leading-snug text-muted-foreground">{summary}</p>
		);
	}
	return (
		<details className="group">
			{/* `list-none` + the webkit marker rule remove the default disclosure
			    triangle in every engine; the chevron replaces it so the affordance
			    sits at the END of the sentence, where the eye already is. */}
			<summary className="flex cursor-pointer list-none items-start gap-tight text-xs leading-snug text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
				<span className="min-w-0">{summary}</span>
				<ChevronDown className="mt-0.5 h-3 w-3 shrink-0 transition-transform duration-200 group-open:rotate-180" />
			</summary>
			<p className="mt-tight border-l border-border pl-item text-xs leading-snug text-muted-foreground">
				{detail}
			</p>
		</details>
	);
}

/**
 * A measurement or derived preview belonging to one setting.
 *
 * `.figure-lg` is the established treatment for "a number the page measured"
 * (see globals.css) — using it here is what separates a computed result from
 * the prose describing the setting, which was the whole complaint about this
 * page: every value and every description rendered at the same size, weight
 * and colour.
 */
export function SettingFigure({
	figure,
	note,
}: {
	figure: string;
	note?: string;
}) {
	return (
		<div className="flex items-baseline gap-item">
			<span className="figure-lg">{figure}</span>
			{note && (
				<span className="text-xs tabular-nums text-muted-foreground">
					{note}
				</span>
			)}
		</div>
	);
}

/**
 * Number input + unit + Save, as one cluster.
 *
 * The unit sits in a fixed-width track. That single detail is what makes the
 * Save buttons form a column instead of stepping left and right with the length
 * of the word beside them.
 */
export function SettingNumberControl({
	value,
	unit,
	min,
	max,
	step,
	disabled,
	canSave,
	onChange,
	onSave,
	inputClassName,
}: {
	value: number;
	unit: string;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	canSave: boolean;
	onChange: (raw: string) => void;
	onSave: () => void;
	inputClassName?: string;
}) {
	return (
		<div className="flex items-center gap-item">
			<Input
				type="number"
				min={min}
				max={max}
				step={step}
				value={value}
				disabled={disabled}
				onChange={(e) => onChange(e.target.value)}
				className={cn("w-24", inputClassName)}
			/>
			<span className="w-16 shrink-0 text-sm text-muted-foreground">
				{unit}
			</span>
			<Button size="sm" disabled={disabled || !canSave} onClick={onSave}>
				Save
			</Button>
		</div>
	);
}

/** One editable column of a {@link SettingListControl} row. */
export interface SettingListField {
	/** Key into the row object. */
	key: string;
	placeholder: string;
	/** Relative width. Two fields at 2 and 1 give a wide path and a short name. */
	grow?: number;
}

/**
 * A repeated-row list editor: add, remove, edit in place, save the whole list.
 *
 * Whole-list save rather than per-item endpoints, unlike the combo slot builder
 * this otherwise resembles. That one can address rows individually because the
 * server assigns each an id; these rows live in a JSON config file and have no
 * identity beyond their position, so the only coherent unit of change is the
 * list.
 *
 * Rows are keyed by INDEX on purpose. The values are what the operator is
 * editing, so keying by value would remount the focused input on every
 * keystroke and by construction cannot be unique while a duplicate is being
 * typed.
 *
 * There is deliberately NO Save button here. A control that owned one would
 * imply it could be saved by itself, and a caller whose lists are written as a
 * single payload would then show two buttons that do the same thing. Saving is
 * the caller's, at whatever granularity its endpoint actually has.
 */
export function SettingListControl({
	name,
	fields,
	rows,
	addLabel,
	emptyLabel,
	disabled,
	onChange,
	onReset,
	resetLabel,
}: {
	/**
	 * What this list holds, singular ("root", "override"). Used to label every
	 * input — these are bare text boxes in a repeated row, so without a label
	 * neither a screen reader nor a test can say which one it is looking at.
	 */
	name: string;
	fields: SettingListField[];
	rows: Record<string, string>[];
	addLabel: string;
	emptyLabel: string;
	disabled?: boolean;
	onChange: (rows: Record<string, string>[]) => void;
	/** Optional per-list "restore defaults" action. Edits the draft, not the server. */
	onReset?: () => void;
	resetLabel?: string;
}) {
	const updateCell = (index: number, key: string, value: string) => {
		onChange(
			rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)),
		);
	};

	return (
		<div className="flex flex-col gap-tight">
			{rows.length === 0 && (
				<p className="text-sm text-muted-foreground">{emptyLabel}</p>
			)}
			{rows.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the row's own values are the edit target
				<div key={index} className="flex items-center gap-item">
					{fields.map((field) => (
						<Input
							key={field.key}
							value={row[field.key] ?? ""}
							placeholder={field.placeholder}
							disabled={disabled}
							aria-label={`${name} ${index + 1} ${field.key}`}
							onChange={(e) => updateCell(index, field.key, e.target.value)}
							className="min-w-0"
							style={{ flexGrow: field.grow ?? 1, flexBasis: 0 }}
						/>
					))}
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						aria-label={`Remove ${name} ${index + 1}`}
						onClick={() => onChange(rows.filter((_, i) => i !== index))}
					>
						Remove
					</Button>
				</div>
			))}
			<div className="flex items-center gap-item">
				<Button
					size="sm"
					variant="outline"
					disabled={disabled}
					onClick={() =>
						onChange([
							...rows,
							Object.fromEntries(fields.map((f) => [f.key, ""])),
						])
					}
				>
					{addLabel}
				</Button>
				{onReset && (
					<Button
						size="sm"
						variant="ghost"
						disabled={disabled}
						onClick={onReset}
					>
						{resetLabel ?? "Restore defaults"}
					</Button>
				)}
			</div>
		</div>
	);
}
