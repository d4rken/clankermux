import { getModelShortName } from "@clankermux/core";
import { formatNumber, formatTokens } from "@clankermux/ui-common";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLORS } from "../../constants";
import {
	type SeriesPalette,
	useSeriesPalette,
} from "../../hooks/useSeriesPalette";
import {
	buildLanes,
	hitTest,
	LANE_HEIGHT,
	type Lane,
	type LiveEvent,
	type LiveStatus,
	MARK_OPACITY,
	type ModelRanking,
	markCenterX,
	markRadius,
	NOW_INSET,
	rankModels,
} from "../../lib/live-activity";
import type { Outage } from "../../lib/live-activity-store";
import { LIVE_WINDOW_OPTIONS } from "../../lib/live-activity-window";
import {
	laneRequestsHref,
	requestDetailsHref,
	resolveMarkHref,
} from "../../lib/requests-link";
import { useLiveActivity, useLiveWindow } from "../RequestEventProvider";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";

/**
 * Live per-project request activity: a rolling window in which every request is
 * one mark placed at its own arrival time.
 *
 * Density reads as load, gaps read as stalls, failures pop out — which is what
 * the Overview's aggregates cannot show. The card answers "who is working right
 * now, and is anything wedged?" at a glance.
 *
 * Split into a pure `LiveActivityLanesView` plus a wiring container so the
 * markup can be asserted with `renderToStaticMarkup`, matching
 * `SystemHealthStrip`.
 */

const AXIS_HEIGHT = 20;
/**
 * How many NAMED project lanes the card draws. `(no project)` and the `Other`
 * overflow lane are extra rows outside this quota (see `buildLanes`), so the
 * card is at most 10 rows. Exported for the lane tests.
 */
export const MAX_LANES = 8;
const DEFAULT_PLOT_WIDTH = 720;

/**
 * Status → mark colour, for the statuses that keep one.
 *
 * Failure holds its hue; healthy traffic gives its hue up to the MODEL. That
 * split is the whole point of colouring the card: 99.7% of requests here
 * complete with a 200, so a status-keyed palette spent the entire colour
 * channel on a distinction that almost never varies, and the card was a field
 * of identical blue dots.
 *
 * The three healthy statuses are absent from this map deliberately: a missing
 * entry means "ask the model palette". That includes `pending`, which is
 * coloured from the REQUESTED model — known from ingress onwards, so in-flight
 * work shows what it is waiting on rather than sitting anonymous. A mark can
 * therefore change hue once if the upstream reports a different model than was
 * asked for (an alias resolving to a dated id, say); that is rare, and showing
 * nothing until the response lands would be worse on a card whose job is to
 * show what is in flight. A model-less event falls back to neutral.
 *
 * Amber and red stay exclusive to failure. `model-colors.test.ts` enforces
 * that no model hue comes within 15 dE of either (7.9 under simulated
 * dichromacy), so a red mark on this card is always an error and never an
 * Opus. Every status also has its own SHAPE, so none of this is colour-alone.
 */
const STATUS_COLOR: Partial<Record<LiveStatus, string>> = {
	rate_limited: COLORS.warning,
	error: COLORS.error,
	lost: "var(--muted-foreground)",
};

/**
 * Colour for the models outside the top few, and for events with no model at
 * all.
 *
 * `MODEL_PALETTE.grey` rather than `--muted-foreground`, which already means
 * "outcome unknown" on this card: the two sit dE 30.2 apart on the dark ground
 * and 19.3 on the light one, so a de-emphasised model still reads as a
 * different thing from a `lost` request.
 */
function otherColor(palette: SeriesPalette): string {
	return palette.hue.grey;
}

/**
 * Mark colour for one event: failure keeps its status hue, and work gets its
 * model's hue if that model is one of the few the legend names.
 *
 * `colored` is a set of SHORT names, matching how the ranking and the legend
 * key models — so a dated id and its alias are one model here as they are
 * everywhere else.
 */
function markColor(
	event: LiveEvent,
	palette: SeriesPalette,
	colored: ReadonlySet<string>,
): string {
	const status = STATUS_COLOR[event.status];
	if (status) return status;
	if (!event.model) return otherColor(palette);
	return colored.has(getModelShortName(event.model))
		? palette.forModel(event.model)
		: otherColor(palette);
}

const STATUS_LABEL: Record<LiveStatus, string> = {
	pending: "waiting for upstream",
	streaming: "streaming",
	ok: "completed",
	rate_limited: "rate limited (429)",
	error: "failed",
	lost: "outcome unknown",
};

export interface LiveActivityLanesViewProps {
	lanes: Lane[];
	/** Right edge of the time axis. */
	now: number;
	windowMs: number;
	plotWidth: number;
	connected: boolean;
	outages: readonly Outage[];
	coverageFrom: number | null;
	primed: boolean;
	/**
	 * Model hues for the ground being painted. A PROP rather than a
	 * `useSeriesPalette()` call inside the view, so this stays a pure function
	 * of its inputs: the hook subscribes to `<html>`'s class with a
	 * MutationObserver, which is exactly the kind of live wiring the
	 * view/container split keeps out of here.
	 */
	palette: SeriesPalette;
	/** Currently highlighted event, if any. */
	selected?: LiveEvent | null;
	/**
	 * Window selector wiring. Optional so the view stays renderable without a
	 * provider; omitted, the window is simply fixed at whatever `windowMs` says.
	 */
	windowControl?: {
		value: number;
		onChange: (ms: number) => void;
	};
	/**
	 * Interaction wiring. Optional so the view stays a pure function of props
	 * and can be rendered on the server.
	 */
	plot?: {
		ref?: React.Ref<SVGSVGElement>;
		/**
		 * The plot COLUMN, not the card. `plotWidth` sets the viewBox, so it has
		 * to be measured on the element the SVG actually fills — measuring the
		 * card would include the label and readout gutters and squash every mark
		 * and tick leftwards.
		 */
		areaRef?: React.Ref<HTMLDivElement>;
		/**
		 * The group holding everything anchored to an absolute moment — the
		 * marks and the unknown-history hatching, and nothing else. The scroll
		 * transform goes here, NOT on the card: translating the card would slide
		 * the labels and axis with it and move the marks in lockstep with their
		 * own gridlines, which is visually no movement at all.
		 */
		scrollRef?: React.Ref<SVGGElement>;
		onPointerMove?: React.PointerEventHandler<SVGSVGElement>;
		onPointerLeave?: React.PointerEventHandler<SVGSVGElement>;
		onKeyDown?: React.KeyboardEventHandler<SVGSVGElement>;
		onClick?: React.MouseEventHandler<SVGSVGElement>;
		onFocus?: React.FocusEventHandler<SVGSVGElement>;
		/**
		 * Lands on the WRAPPER around the plot and the selected-request link, not
		 * on the SVG. Tabbing from the plot to that link is a blur of the SVG; if
		 * it cleared the selection there, the link would unmount mid-tab and the
		 * focus would have nowhere to go.
		 */
		onBlur?: React.FocusEventHandler<HTMLDivElement>;
	};
}

/** Pure renderer. No refs, no timers — safe to render on the server. */
export function LiveActivityLanesView({
	lanes,
	now,
	windowMs,
	plotWidth,
	connected,
	outages,
	coverageFrom,
	primed,
	palette,
	selected = null,
	plot,
	windowControl,
}: LiveActivityLanesViewProps) {
	const usable = Math.max(plotWidth - NOW_INSET, 1);
	const pxPerMs = usable / windowMs;
	const xOf = (ts: number) => usable - (now - ts) * pxPerMs;

	const activeCount = lanes.reduce((sum, lane) => sum + lane.active, 0);
	const requestCount = lanes.reduce((sum, lane) => sum + lane.requests, 0);
	const perMinute = requestCount / (windowMs / 60_000);

	const height = lanes.length * LANE_HEIGHT + AXIS_HEIGHT;

	// One ranking, shared by the marks and the legend, so the key can never
	// disagree with what is drawn.
	const ranking = rankModels(lanes);
	const colored = new Set(ranking.colored);

	return (
		<Card>
			<CardHeader className="p-4 pb-2">
				{/* The selector is anchored to the card's top-right corner rather than
				    trailing the readouts: `active` and `req/min` change width every
				    tick, and a control at the end of that row would shift under the
				    pointer between clicks. Pinning it to a corner nothing else shares
				    keeps it still. `items-start` so it stays on the title's line
				    however far the description wraps. */}
				<div className="flex items-start justify-between gap-x-group">
					<div className="min-w-0">
						<CardTitle>Live Activity</CardTitle>
						<CardDescription>
							Every request in the last {Math.round(windowMs / 60_000)} minutes,
							by project. Colour shows the model, shape shows the outcome, size
							follows token count. Click a mark to open its request.
						</CardDescription>
					</div>
					{windowControl && (
						<WindowSelector
							value={windowControl.value}
							onChange={windowControl.onChange}
						/>
					)}
				</div>
				{/* Wraps rather than overflowing: on a phone-width card the three
				    readouts are wider than the interior, and a non-wrapping row
				    would clip them or push the page sideways. */}
				<div className="mt-item flex flex-wrap items-center gap-x-row gap-y-item text-sm">
					<span className="flex items-center gap-item">
						<span
							className="inline-block h-2 w-2 rounded-full"
							style={{
								backgroundColor: connected
									? COLORS.success
									: "var(--muted-foreground)",
							}}
							aria-hidden="true"
						/>
						<span className="text-muted-foreground">
							{connected ? "live" : "reconnecting"}
						</span>
					</span>
					<span className="font-medium">{activeCount} active</span>
					<span className="text-muted-foreground tabular-nums">
						{formatNumber(Math.round(perMinute))} req/min
					</span>
				</div>
			</CardHeader>
			<CardContent className="p-4 pt-2">
				{lanes.length === 0 ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						{primed
							? "No requests in the last few minutes."
							: "Waiting for the request stream…"}
					</p>
				) : (
					<>
						<div className="flex gap-row">
							{/* Lane labels — real text, not SVG, so they wrap, truncate and
						    are selectable like any other list. NOT aria-hidden: each
						    label that maps to a single filter is a link, and focusable
						    content inside an aria-hidden subtree is an accessibility
						    violation. */}
							<ul className="w-32 shrink-0 space-y-0 pt-0">
								{lanes.map((lane) => {
									const href = laneRequestsHref(lane.scope);
									return (
										<li
											key={lane.key}
											className="flex items-center truncate text-sm text-muted-foreground"
											style={{ height: LANE_HEIGHT }}
											title={lane.label}
										>
											{/* The overflow lane aggregates several projects, so no
										    single project filter expresses it — it stays text
										    rather than linking to a subset of what it shows. */}
											{href === null ? (
												lane.label
											) : (
												<a
													href={href}
													target="_blank"
													rel="noopener noreferrer"
													aria-label={`Show ${lane.label} requests`}
													className="truncate hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
												>
													{lane.label}
												</a>
											)}
										</li>
									);
								})}
							</ul>

							{/* Wrapper, so a blur can tell "focus left the plot area" from
						    "focus moved to the selected-request link below the plot".
						    Focus BOOKKEEPING for the controls inside it, not an
						    interactive element of its own — it is never focusable and
						    has nothing to activate. */}
							{/* biome-ignore lint/a11y/noStaticElementInteractions: onBlur here tracks focus leaving the group, it does not make the div actionable */}
							<div
								className="min-w-0 flex-1"
								ref={plot?.areaRef}
								onBlur={plot?.onBlur}
							>
								<svg
									ref={plot?.ref}
									width="100%"
									height={height}
									viewBox={`0 0 ${plotWidth} ${height}`}
									role="img"
									aria-label={describeLanes(lanes, windowMs)}
									className={`overflow-visible focus:outline-none focus-visible:ring-1 focus-visible:ring-ring${
										plot?.onClick ? " cursor-pointer" : ""
									}`}
									// The 28px lane row is the hit target: the pointer only
									// has to be CLOSEST to a mark, never on it. A 5px dot is
									// a pinpoint nobody lands on reliably, and at this
									// density per-mark hit areas would overlap anyway. The
									// CLICK path additionally caps the horizontal distance
									// (see resolveMarkHref) so empty space does not open a
									// request minutes away from the pointer.
									tabIndex={plot ? 0 : undefined}
									onPointerMove={plot?.onPointerMove}
									onPointerLeave={plot?.onPointerLeave}
									onKeyDown={plot?.onKeyDown}
									onClick={plot?.onClick}
									onFocus={plot?.onFocus}
								>
									<title>{describeLanes(lanes, windowMs)}</title>
									<defs>
										<clipPath id="live-activity-plot">
											<rect x={0} y={0} width={plotWidth} height={height} />
										</clipPath>
										<pattern
											id="live-activity-unknown"
											width={6}
											height={6}
											patternUnits="userSpaceOnUse"
											patternTransform="rotate(45)"
										>
											<line
												x1={0}
												y1={0}
												x2={0}
												y2={6}
												stroke="var(--muted-foreground)"
												strokeWidth={1}
												opacity={0.25}
											/>
										</pattern>
									</defs>

									<g clipPath="url(#live-activity-plot)">
										{/* Minute gridlines. NOT part of the scrolling group: they
									    mark offsets FROM now (-1m, -2m, …), so they belong to
									    the axis and must stay put while time passes. Solid
									    hairlines — dashing would read as a threshold. */}
										{minuteTicks(windowMs).map((offset) => (
											<line
												key={offset}
												x1={xOf(now - offset)}
												y1={0}
												x2={xOf(now - offset)}
												y2={lanes.length * LANE_HEIGHT}
												stroke="var(--border)"
												strokeWidth={1}
											/>
										))}

										{/* Everything anchored to an ABSOLUTE moment, and only
									    that: the marks and the regions we cannot speak for.
									    This is the group the animation frame translates, so it
									    must not contain the axis, the labels or the card
									    chrome — translating those would slide the whole card
									    sideways and move the marks WITH their own axis, which
									    is no movement at all. */}
										<g ref={plot?.scrollRef}>
											{/* Rendered UNDER the marks so a hatch can never hide a
										    real request. */}
											{unknownRegions({
												now,
												windowMs,
												coverageFrom,
												outages,
											}).map((region) => (
												<rect
													key={region.key}
													x={Math.max(xOf(region.from), 0)}
													y={0}
													width={Math.max(
														xOf(region.to) - Math.max(xOf(region.from), 0),
														0,
													)}
													height={lanes.length * LANE_HEIGHT}
													fill="url(#live-activity-unknown)"
												>
													<title>{region.label}</title>
												</rect>
											))}

											{lanes.map((lane, laneIndex) => (
												<g key={lane.key}>
													{lane.events.map((event) => (
														<Mark
															key={event.id}
															event={event}
															palette={palette}
															colored={colored}
															cx={markCenterX(
																event.ts,
																now,
																windowMs,
																plotWidth,
															)}
															cy={laneIndex * LANE_HEIGHT + LANE_HEIGHT / 2}
															opacity={MARK_OPACITY}
															selected={selected?.id === event.id}
														/>
													))}
												</g>
											))}
										</g>
									</g>

									{/* "Now" rule, drawn last so it sits above the marks. */}
									<line
										x1={usable}
										y1={0}
										x2={usable}
										y2={lanes.length * LANE_HEIGHT}
										stroke="var(--foreground)"
										strokeWidth={1}
										opacity={0.4}
									/>

									{minuteTicks(windowMs).map((offset) => (
										<text
											key={offset}
											x={xOf(now - offset)}
											y={lanes.length * LANE_HEIGHT + 14}
											textAnchor="middle"
											className="fill-muted-foreground"
											style={{ fontSize: 10 }}
										>
											{offset === 0
												? "now"
												: `-${Math.round(offset / 60_000)}m`}
										</text>
									))}
								</svg>

								{/* Native link semantics for the selected mark. The plot is
							    role="img": Enter on an image role is not announced as
							    actionable, and with no initial selection it would do
							    nothing until an arrow key was guessed. A real anchor is
							    reachable by Tab and reads as a link.

							    The row is RESERVED rather than conditional: `selected` is
							    set by pointer movement as well as by focus, so growing the
							    column by a line of text on hover would shove everything
							    below the card down and back on every pass over a mark. */}
								<div className="mt-1 h-4">
									{selected && (
										<a
											href={requestDetailsHref(selected.id)}
											target="_blank"
											rel="noopener noreferrer"
											className="inline-block text-xs text-muted-foreground underline hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										>
											Open selected request
										</a>
									)}
								</div>
							</div>

							{/* Direct labels: every number the marks encode is also written
						    out, so nothing is reachable only by hovering. */}
							<ul className="w-40 shrink-0 space-y-0 text-right text-xs">
								{lanes.map((lane) => (
									<li
										key={lane.key}
										className="flex items-center justify-end gap-item tabular-nums"
										style={{ height: LANE_HEIGHT }}
									>
										<span className="font-medium">{lane.requests} req</span>
										<span className="text-muted-foreground">
											{formatTokens(lane.tokens)}
										</span>
										{lane.rateLimited > 0 && (
											<span style={{ color: COLORS.warning }}>
												{lane.rateLimited} 429
											</span>
										)}
										{lane.errors > 0 && (
											<span style={{ color: COLORS.error }}>
												{lane.errors} err
											</span>
										)}
									</li>
								))}
							</ul>
						</div>
						<ModelLegend ranking={ranking} palette={palette} />
					</>
				)}
			</CardContent>
		</Card>
	);
}

/**
 * Swatch-and-name key for the models currently on the plot.
 *
 * Only the models actually present are listed. A fixed key for every model the
 * registry knows would be mostly dead entries, and the point of the legend is
 * to decode what is on screen right now.
 *
 * Ordered by NAME, not by volume. Volume ordering reshuffles the row as the
 * window rolls and one model overtakes another, which turns a reference strip
 * into motion in the corner of the eye. Alphabetical is arbitrary but it holds
 * still, and holding still is the property that matters for something you scan
 * rather than read.
 */
function ModelLegend({
	ranking,
	palette,
}: {
	ranking: ModelRanking;
	palette: SeriesPalette;
}) {
	// Ranked busiest-first for the CUT, then listed alphabetically. Volume
	// decides which models are named; showing them in volume order would make
	// the row reorder itself as the window rolls and two models trade places,
	// which is motion in the corner of the eye for no information.
	const models = useMemo(
		() => [...ranking.colored].sort((a, b) => a.localeCompare(b)),
		[ranking.colored],
	);

	if (models.length === 0 && ranking.otherModels === 0) return null;

	return (
		<ul className="mt-2 flex flex-wrap items-center gap-x-row gap-y-item border-t pt-2 text-xs text-muted-foreground">
			{models.map((shortName) => (
				<li key={shortName} className="flex items-center gap-item">
					<span
						className="inline-block h-2 w-2 shrink-0 rounded-full"
						style={{
							backgroundColor: palette.forModel(
								ranking.idFor.get(shortName) ?? shortName,
							),
						}}
						aria-hidden="true"
					/>
					{shortName}
				</li>
			))}
			{ranking.otherModels > 0 && (
				// Counted, not just labelled "Other": the number is the only thing
				// telling you whether the grey marks are one stray model or a dozen.
				<li className="flex items-center gap-item">
					<span
						className="inline-block h-2 w-2 shrink-0 rounded-full"
						style={{ backgroundColor: otherColor(palette) }}
						aria-hidden="true"
					/>
					{ranking.otherModels} more
				</li>
			)}
			{/* Named alongside the models because they are the other thing a
			    mark's appearance can mean. Without them a red X reads as one more
			    model whose swatch is missing from the row. */}
			<li className="flex items-center gap-item">
				<span
					className="inline-block h-2 w-2 shrink-0"
					style={{
						backgroundColor: COLORS.warning,
						clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
					}}
					aria-hidden="true"
				/>
				429
			</li>
			<li className="flex items-center gap-item">
				<span aria-hidden="true" style={{ color: COLORS.error }}>
					✕
				</span>
				failed
			</li>
		</ul>
	);
}

/**
 * Time-scale selector for the card.
 *
 * Sits on the card rather than in the page's filter row because it scopes only
 * this card, and its scale (minutes) has nothing to do with the Overview's
 * range picker (hours to days) — feeding one from the other would be nonsense.
 * The card is mounted ABOVE that picker for the same reason: so it reads as
 * outside its scope rather than as a second control competing with it.
 */
function WindowSelector({
	value,
	onChange,
}: {
	value: number;
	onChange: (ms: number) => void;
}) {
	return (
		<fieldset
			// A fieldset rather than role="group": same semantics, native
			// element. `min-w-0` undoes the UA's min-inline-size; `shrink-0`
			// then keeps the four options at full width in the header's flex
			// row, so the description column absorbs any narrowing instead.
			className="flex min-w-0 shrink-0 items-center gap-tight rounded-md border p-0.5"
			aria-label="Live activity time range"
		>
			{LIVE_WINDOW_OPTIONS.map((option) => {
				const active = option.ms === value;
				return (
					<button
						key={option.ms}
						type="button"
						onClick={() => onChange(option.ms)}
						aria-pressed={active}
						className={`rounded px-1.5 py-0.5 text-xs tabular-nums transition-colors ${
							active
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-muted"
						}`}
					>
						{option.label}
					</button>
				);
			})}
		</fieldset>
	);
}

/** One request. Shape carries the status; colour carries the model. */
function Mark({
	event,
	palette,
	colored,
	cx,
	cy,
	opacity,
	selected,
}: {
	event: LiveEvent;
	palette: SeriesPalette;
	colored: ReadonlySet<string>;
	cx: number;
	cy: number;
	opacity: number;
	selected: boolean;
}) {
	const color = markColor(event, palette, colored);
	const r = markRadius(event.tokens);
	// A 2px surface ring rather than a border, so overlapping marks stay
	// separable without adding a second ink colour.
	// Opaque by necessity: this ring separates overlapping lane dots by
	// punching a hole in whatever sits behind them, so it cannot follow --card
	// into transparency.
	const ring = { stroke: "var(--surface-raised)", strokeWidth: 2 };
	// The model is named here as well as coloured. Hue identifies it only once
	// you have read the legend, and there are more models than anyone keeps in
	// their head — the tooltip is what makes a mark self-describing.
	const label = [
		event.project ?? "no project",
		event.model ? getModelShortName(event.model) : null,
		STATUS_LABEL[event.status],
	]
		.filter(Boolean)
		.join(" · ");

	const halo = selected ? (
		<circle
			cx={cx}
			cy={cy}
			r={r + 4}
			fill="none"
			stroke={color}
			strokeWidth={1}
		/>
	) : null;

	if (event.status === "error") {
		const a = r + 1;
		return (
			<g opacity={opacity}>
				<title>{label}</title>
				{halo}
				<line
					x1={cx - a}
					y1={cy - a}
					x2={cx + a}
					y2={cy + a}
					stroke={color}
					strokeWidth={2}
					strokeLinecap="round"
				/>
				<line
					x1={cx + a}
					y1={cy - a}
					x2={cx - a}
					y2={cy + a}
					stroke={color}
					strokeWidth={2}
					strokeLinecap="round"
				/>
			</g>
		);
	}

	if (event.status === "rate_limited") {
		const a = r + 1.5;
		return (
			<g opacity={opacity}>
				<title>{label}</title>
				{halo}
				<polygon
					points={`${cx},${cy - a} ${cx + a},${cy + a * 0.8} ${cx - a},${cy + a * 0.8}`}
					fill={color}
					{...ring}
				/>
			</g>
		);
	}

	// In-flight work is hollow: the request has not produced its numbers yet, so
	// a filled mark would imply a size it does not have. Pending is dashed
	// (waiting on the upstream), streaming is solid (bytes are moving).
	if (event.status === "pending" || event.status === "streaming") {
		return (
			<g opacity={opacity}>
				<title>{label}</title>
				{halo}
				<circle
					cx={cx}
					cy={cy}
					r={r}
					fill="none"
					stroke={color}
					strokeWidth={2}
					strokeDasharray={event.status === "pending" ? "2 2" : undefined}
				/>
			</g>
		);
	}

	if (event.status === "lost") {
		return (
			<g opacity={opacity}>
				<title>{label}</title>
				{halo}
				<circle
					cx={cx}
					cy={cy}
					r={r}
					fill="none"
					stroke={color}
					strokeWidth={1}
				/>
			</g>
		);
	}

	return (
		<g opacity={opacity}>
			<title>{label}</title>
			{halo}
			<circle cx={cx} cy={cy} r={r} fill={color} {...ring} />
		</g>
	);
}

/**
 * Gridline offsets from `now`, spaced so the axis stays readable at any window.
 *
 * A fixed one-minute spacing puts 31 labelled ticks on a half-hour window,
 * which reads as noise and overlaps its own text. Aim for a handful instead.
 */
function minuteTicks(windowMs: number): number[] {
	const minutes = windowMs / 60_000;
	const step = (minutes <= 6 ? 1 : minutes <= 12 ? 2 : 5) * 60_000;
	const ticks: number[] = [];
	for (let offset = 0; offset <= windowMs; offset += step) ticks.push(offset);
	return ticks;
}

interface UnknownRegion {
	key: string;
	from: number;
	to: number;
	label: string;
}

/**
 * Stretches of the timeline we cannot speak for.
 *
 * Two causes, one affordance: history we never loaded, and a connection outage.
 * Both would otherwise be rendered as an empty stretch, which reads as "nothing
 * happened" — the one thing this card must never say by accident.
 */
export function unknownRegions({
	now,
	windowMs,
	coverageFrom,
	outages,
}: {
	now: number;
	windowMs: number;
	coverageFrom: number | null;
	outages: readonly Outage[];
}): UnknownRegion[] {
	const regions: UnknownRegion[] = [];
	const windowStart = now - windowMs;

	// `null` means nothing is covered — no history fetched and the stream has
	// never connected — so the whole window is unknown. Treating absence as
	// "fully covered" is how a failed backfill turns into a confident, wrong
	// claim that nothing happened.
	const covered = coverageFrom ?? now;
	if (covered > windowStart) {
		regions.push({
			key: "history",
			from: windowStart,
			to: covered,
			label: `No history loaded before ${new Date(covered).toLocaleTimeString()}`,
		});
	}

	for (const outage of outages) {
		// `to: null` means still down, so the gap genuinely does run to now.
		// A CLOSED outage must stop where it stopped — extending it to the
		// present would hatch healthy post-reconnect traffic as unknown.
		const to = outage.to ?? now;
		if (to < windowStart) continue;
		regions.push({
			key: `outage-${outage.from}`,
			from: Math.max(outage.from, windowStart),
			to,
			label:
				outage.to === null
					? "Stream disconnected — requests are not being shown here right now"
					: `Stream was disconnected ${new Date(outage.from).toLocaleTimeString()}–${new Date(outage.to).toLocaleTimeString()} — requests in this period may be missing`,
		});
	}

	return regions;
}

function describeLanes(lanes: Lane[], windowMs: number): string {
	const minutes = Math.round(windowMs / 60_000);
	const parts = lanes.map(
		(lane) =>
			`${lane.label}: ${lane.requests} requests, ${formatTokens(lane.tokens)}${
				lane.rateLimited > 0 ? `, ${lane.rateLimited} rate limited` : ""
			}${lane.errors > 0 ? `, ${lane.errors} failed` : ""}`,
	);
	return `Request activity over the last ${minutes} minutes by project. ${parts.join(". ")}`;
}

/**
 * Wiring container: subscribes to the live store, keeps the marks scrolling
 * between renders, and resolves pointer position to an event.
 */
export function LiveActivityLanes() {
	const { events, connected, outages, coverageFrom, primed } =
		useLiveActivity();
	const { windowMs, setWindowMs } = useLiveWindow();

	const plotAreaRef = useRef<HTMLDivElement>(null);
	const [plotWidth, setPlotWidth] = useState(DEFAULT_PLOT_WIDTH);
	const [reducedMotion, setReducedMotion] = useState(false);

	/**
	 * The layout origin for the time axis, advanced once a second.
	 *
	 * Deliberately state rather than a `Date.now()` read during render: render
	 * has to be pure, and a fresh clock read every render would also invalidate
	 * the lane memo on every unrelated re-render. Between these ticks the marks
	 * are moved by the animation frame below — under reduced motion they simply
	 * step here instead.
	 */
	const [renderNow, setRenderNow] = useState(() => Date.now());

	/**
	 * Previous lane order, fed back so rows stay put as volumes shift.
	 *
	 * Written during render, which is safe here because `buildLanes` is
	 * idempotent in this argument: feeding its own output back with the same
	 * events reproduces that order exactly (everything is "surviving", nothing
	 * is an entrant), so a double invocation cannot drift.
	 */
	const orderRef = useRef<string[]>([]);
	const { lanes, order } = useMemo(
		() => buildLanes(events, renderNow, windowMs, MAX_LANES, orderRef.current),
		[events, renderNow, windowMs],
	);
	orderRef.current = order;

	useEffect(() => {
		const id = setInterval(() => setRenderNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const sync = () => setReducedMotion(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);

	useEffect(() => {
		const element = plotAreaRef.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			const width = entry.contentRect.width;
			if (width > 0) setPlotWidth(width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		<div>
			<ScrollingLanes
				plotAreaRef={plotAreaRef}
				lanes={lanes}
				renderNow={renderNow}
				windowMs={windowMs}
				setWindowMs={setWindowMs}
				plotWidth={plotWidth}
				connected={connected}
				outages={outages}
				coverageFrom={coverageFrom}
				primed={primed}
				reducedMotion={reducedMotion}
			/>
		</div>
	);
}

/**
 * Applies the between-render scroll.
 *
 * Marks are laid out against `renderNow` — an ABSOLUTE origin captured at
 * render — and the whole plot is then translated by however much wall-clock
 * time has passed since. Deriving the offset from a fixed origin rather than
 * accumulating it per frame is what stops the 1 Hz relayout and the animation
 * frame from double-advancing the marks.
 *
 * Exported for the DOM test lane: this is where the pointer, click and focus
 * handling lives, and asserting a copy of it would prove nothing about it.
 */
export function ScrollingLanes({
	plotAreaRef,
	lanes,
	renderNow,
	windowMs,
	setWindowMs,
	plotWidth,
	connected,
	outages,
	coverageFrom,
	primed,
	reducedMotion,
}: {
	plotAreaRef: React.Ref<HTMLDivElement>;
	lanes: Lane[];
	renderNow: number;
	windowMs: number;
	setWindowMs: (ms: number) => void;
	plotWidth: number;
	connected: boolean;
	outages: readonly Outage[];
	coverageFrom: number | null;
	primed: boolean;
	reducedMotion: boolean;
}) {
	const scrollRef = useRef<SVGGElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	// Resolved here rather than in the outer container because this is the
	// component that renders the view, and the DOM tests mount THIS one
	// directly — threading the palette down from `LiveActivityLanes` would
	// leave those mounts without one.
	const palette = useSeriesPalette();
	const pxPerMs = Math.max(plotWidth - NOW_INSET, 1) / windowMs;
	const [cursor, setCursor] = useState<{
		laneIndex: number;
		eventIndex: number;
	} | null>(null);

	// Resolved from the CURRENT lanes so a selection can never outlive the mark
	// it points at — lanes are rebuilt as events prune.
	const selected = cursor
		? (lanes[cursor.laneIndex]?.events[cursor.eventIndex] ?? null)
		: null;

	/**
	 * Pointer position in the plot's own coordinate space.
	 *
	 * The bounding rect is the SVG's, which does NOT include the transform
	 * applied to the inner scroll group — only the element's own box.
	 */
	const plotPoint = useCallback(
		(pointer: { clientX: number; clientY: number }) => {
			const element = svgRef.current;
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			const scale = rect.width === 0 ? 1 : plotWidth / rect.width;
			return {
				x: (pointer.clientX - rect.left) * scale,
				y: pointer.clientY - rect.top,
			};
		},
		[plotWidth],
	);

	/**
	 * The instant the marks are CURRENTLY drawn against.
	 *
	 * Marks are laid out against `renderNow` and then translated by
	 * `(Date.now() - renderNow) * pxPerMs` on the inner group, so resolving a
	 * pointer against `renderNow` misses by that offset — up to a few px at the
	 * narrowest window. Reduced motion applies no transform, so there the layout
	 * origin is still the on-screen truth.
	 */
	const hitNow = useCallback(
		() => (reducedMotion ? renderNow : Date.now()),
		[reducedMotion, renderNow],
	);

	const onPointerMove = useCallback(
		(pointerEvent: React.PointerEvent<SVGSVGElement>) => {
			const point = plotPoint(pointerEvent);
			if (!point) return;
			const hit = hitTest(
				lanes,
				point.x,
				point.y,
				hitNow(),
				windowMs,
				plotWidth,
			);
			setCursor(
				hit ? { laneIndex: hit.laneIndex, eventIndex: hit.eventIndex } : null,
			);
		},
		[hitNow, lanes, plotPoint, plotWidth, windowMs],
	);

	/** Open a request in a new tab. Same call for pointer and keyboard. */
	const openRequest = useCallback((href: string) => {
		window.open(href, "_blank", "noopener,noreferrer");
	}, []);

	const onClick = useCallback(
		(mouseEvent: React.MouseEvent<SVGSVGElement>) => {
			const point = plotPoint(mouseEvent);
			if (!point) return;
			const href = resolveMarkHref(
				lanes,
				point.x,
				point.y,
				hitNow(),
				windowMs,
				plotWidth,
			);
			if (href) openRequest(href);
		},
		[hitNow, lanes, openRequest, plotPoint, plotWidth, windowMs],
	);

	/**
	 * Focusing the plot selects something, so Enter always has a target.
	 *
	 * The most recent mark of the first non-empty lane: with no selection at
	 * all, a keyboard user would have to guess that an arrow key is what makes
	 * the plot do anything.
	 */
	const onFocus = useCallback(() => {
		setCursor((prior) => {
			if (prior) return prior;
			const laneIndex = lanes.findIndex((lane) => lane.events.length > 0);
			if (laneIndex === -1) return null;
			return {
				laneIndex,
				eventIndex: lanes[laneIndex].events.length - 1,
			};
		});
	}, [lanes]);

	const onKeyDown = useCallback(
		(keyEvent: React.KeyboardEvent<SVGSVGElement>) => {
			// Convenience only — the authoritative keyboard affordance is the
			// "Open selected request" anchor below the plot, which is a real link.
			// preventDefault so Space does not scroll the page instead.
			if (keyEvent.key === "Enter" || keyEvent.key === " ") {
				keyEvent.preventDefault();
				if (selected) openRequest(requestDetailsHref(selected.id));
				return;
			}

			const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
			if (!keys.includes(keyEvent.key)) return;
			keyEvent.preventDefault();

			setCursor((prior) => {
				const laneIndex = prior?.laneIndex ?? 0;
				const eventIndex = prior?.eventIndex ?? 0;
				if (keyEvent.key === "ArrowUp" || keyEvent.key === "ArrowDown") {
					const step = keyEvent.key === "ArrowDown" ? 1 : -1;
					const nextLane = clamp(laneIndex + step, 0, lanes.length - 1);
					const count = lanes[nextLane]?.events.length ?? 0;
					if (count === 0) return prior;
					return {
						laneIndex: nextLane,
						eventIndex: Math.min(eventIndex, count - 1),
					};
				}
				const count = lanes[laneIndex]?.events.length ?? 0;
				if (count === 0) return prior;
				const step = keyEvent.key === "ArrowRight" ? 1 : -1;
				return {
					laneIndex,
					eventIndex: clamp(eventIndex + step, 0, count - 1),
				};
			});
		},
		[lanes, openRequest, selected],
	);

	const clearCursor = useCallback(() => setCursor(null), []);

	/**
	 * Clear the selection only when focus leaves the plot AREA.
	 *
	 * Tabbing from the plot to the "Open selected request" link is a blur of the
	 * SVG; clearing there would unmount the link the focus is moving to.
	 */
	const onAreaBlur = useCallback(
		(focusEvent: React.FocusEvent<HTMLDivElement>) => {
			if (focusEvent.currentTarget.contains(focusEvent.relatedTarget)) return;
			clearCursor();
		},
		[clearCursor],
	);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		// Reduced motion: no continuous scroll at all. The marks are already
		// positioned against `renderNow`, so clearing the transform leaves them
		// correct — they simply step once a second with the relayout.
		if (reducedMotion) {
			element.removeAttribute("transform");
			return;
		}

		let frame = 0;
		let last = 0;
		const step = () => {
			frame = requestAnimationFrame(step);
			const now = Date.now();
			// ~10fps is plenty for a 4px/second drift and keeps this off the
			// critical path on a busy dashboard.
			if (now - last < 100) return;
			last = now;
			// Offset from the ABSOLUTE render origin rather than accumulated per
			// frame, so the 1 Hz relayout and this loop cannot double-advance:
			// at each relayout `renderNow` catches up and the offset returns to
			// ~0 with the marks already redrawn in the same place.
			element.setAttribute(
				"transform",
				`translate(${-(now - renderNow) * pxPerMs} 0)`,
			);
		};

		const start = () => {
			if (!frame) frame = requestAnimationFrame(step);
		};
		const stop = () => {
			if (frame) cancelAnimationFrame(frame);
			frame = 0;
		};
		const onVisibility = () => (document.hidden ? stop() : start());

		if (!document.hidden) start();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [renderNow, pxPerMs, reducedMotion]);

	return (
		<div className="relative">
			<div>
				<LiveActivityLanesView
					lanes={lanes}
					now={renderNow}
					windowMs={windowMs}
					plotWidth={plotWidth}
					connected={connected}
					outages={outages}
					coverageFrom={coverageFrom}
					primed={primed}
					palette={palette}
					selected={selected}
					windowControl={{ value: windowMs, onChange: setWindowMs }}
					plot={{
						ref: svgRef,
						areaRef: plotAreaRef,
						scrollRef,
						onPointerMove,
						onPointerLeave: clearCursor,
						onBlur: onAreaBlur,
						onKeyDown,
						onClick,
						onFocus,
					}}
				/>
			</div>
			{selected && <MarkTooltip event={selected} />}
		</div>
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Detail for the highlighted mark.
 *
 * Values lead and labels follow — the reader already knows which request they
 * are pointing at and wants the numbers. Everything here is also reachable
 * without hovering: the lane readouts carry the totals and the Requests tab is
 * the full table view.
 */
function MarkTooltip({ event }: { event: LiveEvent }) {
	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none absolute right-4 top-4 z-10 rounded-md border bg-popover/95 px-3 py-2 text-xs shadow-md backdrop-blur"
		>
			<div className="flex items-baseline gap-item">
				<span className="text-sm font-semibold tabular-nums">
					{event.tokens === null ? "—" : formatTokens(event.tokens)}
				</span>
				<span className="text-muted-foreground">tokens</span>
			</div>
			<dl className="mt-1 space-y-tight text-muted-foreground">
				<Row label="Status" value={STATUS_LABEL[event.status]} />
				{event.durationMs !== null && (
					<Row
						label="Duration"
						value={`${(event.durationMs / 1000).toFixed(1)}s`}
					/>
				)}
				{event.model && <Row label="Model" value={event.model} />}
				{event.account && <Row label="Account" value={event.account} />}
				<Row label="Project" value={event.project ?? "(no project)"} />
				<Row label="At" value={new Date(event.ts).toLocaleTimeString()} />
			</dl>
			<p className="mt-1 text-muted-foreground">Click to open details</p>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-row">
			<dt className="w-16 shrink-0">{label}</dt>
			{/* Project, model and account names come from request bodies and
			    upstream responses — rendered as text nodes, never as markup. */}
			<dd className="truncate text-foreground">{value}</dd>
		</div>
	);
}
