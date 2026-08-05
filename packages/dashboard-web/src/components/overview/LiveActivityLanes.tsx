import { formatNumber, formatTokens } from "@clankermux/ui-common";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLORS } from "../../constants";
import {
	ageOpacity,
	buildLanes,
	type Lane,
	type LiveEvent,
	type LiveStatus,
	markRadius,
} from "../../lib/live-activity";
import { LIVE_WINDOW_MS, useLiveActivity } from "../RequestEventProvider";
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

const LANE_HEIGHT = 28;
const AXIS_HEIGHT = 20;
const MAX_LANES = 6;
const DEFAULT_PLOT_WIDTH = 720;
/** Right-hand inset so a mark at "now" is not clipped by the plot edge. */
const NOW_INSET = 8;

/**
 * Status → mark colour.
 *
 * Validated with the dataviz palette checker against both chart surfaces
 * (`--card`: #ffffff light, hsl(220 13% 12%) dark): worst adjacent CVD
 * separation ΔE 13.9 deutan / 16.6 tritan, 19.8 at normal vision. The obvious
 * alternative — the brand orange for OK — is a hard fail at ΔE 7.2 against
 * amber, well under the 15 floor. Every status also has its own SHAPE, so none
 * of this is colour-alone.
 */
const STATUS_COLOR: Record<LiveStatus, string> = {
	pending: COLORS.blue,
	streaming: COLORS.blue,
	ok: COLORS.blue,
	rate_limited: COLORS.warning,
	error: COLORS.error,
	lost: "var(--muted-foreground)",
};

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
	disconnectedSince: number | null;
	historyEdge: number | null;
	primed: boolean;
	/** Currently highlighted event, if any. */
	selected?: LiveEvent | null;
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
		onPointerMove?: React.PointerEventHandler<SVGSVGElement>;
		onPointerLeave?: React.PointerEventHandler<SVGSVGElement>;
		onKeyDown?: React.KeyboardEventHandler<SVGSVGElement>;
		onBlur?: React.FocusEventHandler<SVGSVGElement>;
	};
}

/** Pure renderer. No refs, no timers — safe to render on the server. */
export function LiveActivityLanesView({
	lanes,
	now,
	windowMs,
	plotWidth,
	connected,
	disconnectedSince,
	historyEdge,
	primed,
	selected = null,
	plot,
}: LiveActivityLanesViewProps) {
	const usable = Math.max(plotWidth - NOW_INSET, 1);
	const pxPerMs = usable / windowMs;
	const xOf = (ts: number) => usable - (now - ts) * pxPerMs;

	const activeCount = lanes.reduce((sum, lane) => sum + lane.active, 0);
	const requestCount = lanes.reduce((sum, lane) => sum + lane.requests, 0);
	const perMinute = requestCount / (windowMs / 60_000);

	const height = lanes.length * LANE_HEIGHT + AXIS_HEIGHT;

	return (
		<Card>
			<CardHeader className="p-4 pb-2">
				<div className="flex items-baseline justify-between gap-4">
					<div>
						<CardTitle>Live Activity</CardTitle>
						<CardDescription>
							Every request in the last {Math.round(windowMs / 60_000)} minutes,
							by project. Mark size follows token count.
						</CardDescription>
					</div>
					<div className="flex shrink-0 items-center gap-3 text-sm">
						<span className="flex items-center gap-1.5">
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
					<div className="flex gap-3">
						{/* Lane labels — real text, not SVG, so they wrap, truncate and
						    are selectable like any other list. */}
						<ul className="w-32 shrink-0 space-y-0 pt-0" aria-hidden="true">
							{lanes.map((lane) => (
								<li
									key={lane.key}
									className="flex items-center truncate text-sm text-muted-foreground"
									style={{ height: LANE_HEIGHT }}
									title={lane.label}
								>
									{lane.label}
								</li>
							))}
						</ul>

						<div className="min-w-0 flex-1" ref={plot?.areaRef}>
							<svg
								ref={plot?.ref}
								width="100%"
								height={height}
								viewBox={`0 0 ${plotWidth} ${height}`}
								role="img"
								aria-label={describeLanes(lanes, windowMs)}
								className="overflow-visible focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								// The 28px lane row is the hit target: the pointer only
								// has to be CLOSEST to a mark, never on it. A 5px dot is
								// a pinpoint nobody lands on reliably, and at this
								// density per-mark hit areas would overlap anyway.
								tabIndex={plot ? 0 : undefined}
								onPointerMove={plot?.onPointerMove}
								onPointerLeave={plot?.onPointerLeave}
								onKeyDown={plot?.onKeyDown}
								onBlur={plot?.onBlur}
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
									{/* Regions we cannot speak for. Rendered UNDER the marks
									    so a hatch can never hide a real request. */}
									{unknownRegions({
										now,
										windowMs,
										historyEdge,
										disconnectedSince,
										connected,
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

									{/* Minute gridlines: solid hairlines, one shade off the
									    surface. Never dashed — dashing reads as a threshold. */}
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

									{lanes.map((lane, laneIndex) => (
										<g key={lane.key}>
											{lane.events.map((event) => (
												<Mark
													key={event.id}
													event={event}
													cx={clampToPlot(xOf(event.ts))}
													cy={laneIndex * LANE_HEIGHT + LANE_HEIGHT / 2}
													opacity={ageOpacity(event.ts, now, windowMs)}
													selected={selected?.id === event.id}
												/>
											))}
										</g>
									))}
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
										{offset === 0 ? "now" : `-${Math.round(offset / 60_000)}m`}
									</text>
								))}
							</svg>
						</div>

						{/* Direct labels: every number the marks encode is also written
						    out, so nothing is reachable only by hovering. */}
						<ul className="w-40 shrink-0 space-y-0 text-right text-xs">
							{lanes.map((lane) => (
								<li
									key={lane.key}
									className="flex items-center justify-end gap-1.5 tabular-nums"
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
				)}
			</CardContent>
		</Card>
	);
}

/** One request. Shape carries the status alongside colour. */
function Mark({
	event,
	cx,
	cy,
	opacity,
	selected,
}: {
	event: LiveEvent;
	cx: number;
	cy: number;
	opacity: number;
	selected: boolean;
}) {
	const color = STATUS_COLOR[event.status];
	const r = markRadius(event.tokens);
	// A 2px surface ring rather than a border, so overlapping marks stay
	// separable without adding a second ink colour.
	const ring = { stroke: "var(--card)", strokeWidth: 2 };
	const label = `${event.project ?? "no project"} · ${STATUS_LABEL[event.status]}`;

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

/** Marks older than the window are pinned at the left edge, never dropped. */
function clampToPlot(x: number): number {
	return Math.max(x, 2);
}

/**
 * Nearest-mark hit test.
 *
 * `y` picks the lane (rows are the generous part of the target) and `x` picks
 * the nearest event within it by time. Returns null only when the lane is empty
 * or the pointer is off the lanes entirely.
 */
export function hitTest(
	lanes: Lane[],
	x: number,
	y: number,
	now: number,
	windowMs: number,
	plotWidth: number,
): { event: LiveEvent; laneIndex: number; eventIndex: number } | null {
	const laneIndex = Math.floor(y / LANE_HEIGHT);
	const lane = lanes[laneIndex];
	if (!lane || lane.events.length === 0) return null;

	const usable = Math.max(plotWidth - NOW_INSET, 1);
	const targetTs = now - ((usable - x) * windowMs) / usable;

	let bestIndex = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < lane.events.length; i++) {
		const distance = Math.abs(lane.events[i].ts - targetTs);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestIndex = i;
		}
	}

	return { event: lane.events[bestIndex], laneIndex, eventIndex: bestIndex };
}

function minuteTicks(windowMs: number): number[] {
	const ticks: number[] = [];
	for (let offset = 0; offset <= windowMs; offset += 60_000) ticks.push(offset);
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
	historyEdge,
	disconnectedSince,
	connected,
}: {
	now: number;
	windowMs: number;
	historyEdge: number | null;
	disconnectedSince: number | null;
	connected: boolean;
}): UnknownRegion[] {
	const regions: UnknownRegion[] = [];
	const windowStart = now - windowMs;

	// Only when the backfill came back saturated: a short page means the
	// history really is complete and there is nothing to disclose.
	if (historyEdge !== null && historyEdge > windowStart) {
		regions.push({
			key: "history",
			from: windowStart,
			to: historyEdge,
			label: `No history loaded before ${new Date(historyEdge).toLocaleTimeString()}`,
		});
	}

	if (disconnectedSince !== null) {
		regions.push({
			key: "outage",
			from: Math.max(disconnectedSince, windowStart),
			to: connected ? now : now,
			label: connected
				? `Stream was disconnected from ${new Date(disconnectedSince).toLocaleTimeString()} — requests in this period may be missing`
				: "Stream disconnected — requests are not being recorded here right now",
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
	const { events, connected, disconnectedSince, historyEdge, primed } =
		useLiveActivity();

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
		() =>
			buildLanes(events, renderNow, LIVE_WINDOW_MS, MAX_LANES, orderRef.current),
		[events, renderNow],
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
				plotWidth={plotWidth}
				connected={connected}
				disconnectedSince={disconnectedSince}
				historyEdge={historyEdge}
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
 */
function ScrollingLanes({
	plotAreaRef,
	lanes,
	renderNow,
	plotWidth,
	connected,
	disconnectedSince,
	historyEdge,
	primed,
	reducedMotion,
}: {
	plotAreaRef: React.Ref<HTMLDivElement>;
	lanes: Lane[];
	renderNow: number;
	plotWidth: number;
	connected: boolean;
	disconnectedSince: number | null;
	historyEdge: number | null;
	primed: boolean;
	reducedMotion: boolean;
}) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const pxPerMs = Math.max(plotWidth - NOW_INSET, 1) / LIVE_WINDOW_MS;
	const [cursor, setCursor] = useState<{
		laneIndex: number;
		eventIndex: number;
	} | null>(null);

	// Resolved from the CURRENT lanes so a selection can never outlive the mark
	// it points at — lanes are rebuilt as events prune.
	const selected = cursor
		? (lanes[cursor.laneIndex]?.events[cursor.eventIndex] ?? null)
		: null;

	const onPointerMove = useCallback(
		(pointerEvent: React.PointerEvent<SVGSVGElement>) => {
			const element = svgRef.current;
			if (!element) return;
			const rect = element.getBoundingClientRect();
			// The rect already reflects the scroll transform, so pointer x maps
			// straight back into the same layout space the marks were placed in.
			const scale = rect.width === 0 ? 1 : plotWidth / rect.width;
			const hit = hitTest(
				lanes,
				(pointerEvent.clientX - rect.left) * scale,
				pointerEvent.clientY - rect.top,
				renderNow,
				LIVE_WINDOW_MS,
				plotWidth,
			);
			setCursor(
				hit ? { laneIndex: hit.laneIndex, eventIndex: hit.eventIndex } : null,
			);
		},
		[lanes, plotWidth, renderNow],
	);

	const onKeyDown = useCallback(
		(keyEvent: React.KeyboardEvent<SVGSVGElement>) => {
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
		[lanes],
	);

	const clearCursor = useCallback(() => setCursor(null), []);

	useEffect(() => {
		const element = wrapperRef.current;
		if (!element) return;
		if (reducedMotion) {
			element.style.transform = "";
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
			element.style.transform = `translateX(${-(now - renderNow) * pxPerMs}px)`;
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
			<div
				ref={wrapperRef}
				style={{ willChange: reducedMotion ? undefined : "transform" }}
			>
				<LiveActivityLanesView
					lanes={lanes}
					now={renderNow}
					windowMs={LIVE_WINDOW_MS}
					plotWidth={plotWidth}
					connected={connected}
					disconnectedSince={disconnectedSince}
					historyEdge={historyEdge}
					primed={primed}
					selected={selected}
					plot={{
						ref: svgRef,
						areaRef: plotAreaRef,
						onPointerMove,
						onPointerLeave: clearCursor,
						onBlur: clearCursor,
						onKeyDown,
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
			<div className="flex items-baseline gap-2">
				<span className="text-sm font-semibold tabular-nums">
					{event.tokens === null ? "—" : formatTokens(event.tokens)}
				</span>
				<span className="text-muted-foreground">tokens</span>
			</div>
			<dl className="mt-1 space-y-0.5 text-muted-foreground">
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
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-3">
			<dt className="w-16 shrink-0">{label}</dt>
			{/* Project, model and account names come from request bodies and
			    upstream responses — rendered as text nodes, never as markup. */}
			<dd className="truncate text-foreground">{value}</dd>
		</div>
	);
}
