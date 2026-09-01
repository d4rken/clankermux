import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Table primitives.
 *
 * Eight `<table>`s existed in the app before this, between them carrying three
 * head-cell type treatments, two frame treatments and two row-separator
 * idioms — and `.label-caps` on one of the eight while `.figure` was on none,
 * despite globals.css defining both as the house answer for exactly these two
 * roles (naming a value, and being one).
 *
 * These are thin styled wrappers, NOT a data-driven `<Table columns rows />`.
 * Column counts across the call sites span 3 to 14; one of them changes the
 * ROW's own column schema (an unidentified model collapses three numeric
 * columns into a single `colSpan={3}` cell), which a table-level `columns`
 * array cannot express; and the model-performance table is already data-driven
 * off its own typed metric descriptor with a cross-row normalization pass, so a
 * generic descriptor would mean deleting a working abstraction to rebuild it
 * worse.
 *
 * Deliberately NOT here, so their absence reads as a decision rather than an
 * oversight:
 *
 * - `TableEmpty`. It would have to be told its `colSpan` anyway — a cell in
 *   `<tbody>` never sees the `<thead>` — and a count inferred from anything
 *   else is a silent-miscount generator.
 * - `TableCaption`. Zero call sites.
 * - Any `onSort`/`sortKey` prop. Sort state stays with the owning table (see
 *   sort-header.tsx); the two sortable tables have different comparators and
 *   different defaults.
 * - A `numeric` cell variant. `text-right` and `.figure` are two utilities
 *   `cn()` already merges.
 *
 * Note there is no `border-collapse` class anywhere below. Tailwind's preflight
 * already sets `border-collapse: collapse` on every `table`, and globals.css
 * imports it; two call sites restating it is what made it look like a decision.
 */

const tableFrameVariants = cva("overflow-x-auto", {
	variants: {
		variant: {
			/**
			 * The default: a rounded hairline around the whole table.
			 *
			 * `overflow-x-auto` rather than the `overflow-hidden` the framed call
			 * sites used to spell. The clipping is load-bearing — it is what cuts
			 * the tinted `<thead>` to the rounded corners — and a non-`visible`
			 * value on one axis forces the other to `auto`, so this clips
			 * identically AND gives the 14- and 8-column tables somewhere to go on
			 * a narrow screen, which they did not have.
			 */
			framed: "rounded-md border",
			/**
			 * No frame. For a table that already sits inside a border (an expanded
			 * `<details>`), or one emitted per item inside a `.map`, where framing
			 * would stack N borders down the panel.
			 */
			bare: "",
		},
	},
	defaultVariants: {
		variant: "framed",
	},
});

interface TableFrameProps
	extends React.HTMLAttributes<HTMLDivElement>,
		VariantProps<typeof tableFrameVariants> {}

const TableFrame = React.forwardRef<HTMLDivElement, TableFrameProps>(
	({ className, variant, ...props }, ref) => (
		<div
			ref={ref}
			className={cn(tableFrameVariants({ variant }), className)}
			{...props}
		/>
	),
);
TableFrame.displayName = "TableFrame";

type TableDensity = "default" | "compact";

const DENSITY_PADDING: Record<TableDensity, string> = {
	default: "px-row py-item",
	compact: "px-tight py-tight",
};

/**
 * Density is a property of a TABLE, not of each of its cells.
 *
 * Two of the call sites are deliberately dense — 14 columns at `text-xs`, and
 * one table per fitted window inside a `.map` — and applying the comfortable
 * default to the first would add roughly 336px of width to it. The alternative
 * to a context is the same override repeated on all 27 cells, where a later
 * edit misses one and the columns stop lining up.
 *
 * Compact is `px-tight`, not `px-0`: the dense tables shipped with zero
 * horizontal padding, and columns that touch are a more visible defect than 4px
 * of width per side. `TableFrame` scrolls in both variants, so the extra width
 * can never push the page sideways.
 */
const TableDensityContext = React.createContext<TableDensity>("default");

interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
	density?: TableDensity;
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
	({ className, density = "default", ...props }, ref) => (
		<TableDensityContext.Provider value={density}>
			<table ref={ref} className={cn("w-full text-sm", className)} {...props} />
		</TableDensityContext.Provider>
	),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
	HTMLTableSectionElement,
	React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
	<thead ref={ref} className={cn("bg-muted/50", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
	HTMLTableSectionElement,
	React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
	<tbody ref={ref} className={className} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
	HTMLTableSectionElement,
	React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
	<tfoot
		ref={ref}
		className={cn("bg-muted/30 border-t", className)}
		{...props}
	/>
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<
	HTMLTableRowElement,
	React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
	<tr ref={ref} className={cn("border-t", className)} {...props} />
));
TableRow.displayName = "TableRow";

/**
 * A head cell, whose TYPE TREATMENT is derived from `scope` rather than from a
 * separate variant prop.
 *
 * A `<th scope="row">` labelling a totals row must NOT take `.label-caps`: it
 * sits beside its own `font-medium` figures, and shrinking and muting it makes
 * a data row mimic a column head. `.label-caps` is a base-layer component
 * class, so `cn()` cannot cancel it from a call site — the primitive has to
 * decide. Deriving it from `scope` is one prop instead of two and makes the
 * invalid pairings (a `.label-caps` row label; a bare-weight column head)
 * unrepresentable rather than merely discouraged.
 *
 * `scope` defaults to `col`. Five of the eight tables set none at all before
 * this, so the default is also an accessibility fix.
 */
const TableHead = React.forwardRef<
	HTMLTableCellElement,
	React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, scope, ...props }, ref) => {
	const density = React.useContext(TableDensityContext);
	const resolvedScope = scope ?? "col";
	return (
		<th
			ref={ref}
			scope={resolvedScope}
			className={cn(
				resolvedScope === "row"
					? "font-medium text-left"
					: "label-caps text-left",
				DENSITY_PADDING[density],
				className,
			)}
			{...props}
		/>
	);
});
TableHead.displayName = "TableHead";

/**
 * A body cell. Renders `children` directly — no wrapper element, ever: a test
 * elsewhere asserts on `tokens</td>` adjacency, and a span slipped in here
 * would leave that assertion passing while testing nothing.
 */
const TableCell = React.forwardRef<
	HTMLTableCellElement,
	React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => {
	const density = React.useContext(TableDensityContext);
	return (
		<td
			ref={ref}
			className={cn(DENSITY_PADDING[density], className)}
			{...props}
		/>
	);
});
TableCell.displayName = "TableCell";

export {
	Table,
	TableBody,
	TableCell,
	TableFooter,
	TableFrame,
	TableHead,
	TableHeader,
	TableRow,
};
