/**
 * Links from the Overview's Live Activity card into the Requests page.
 *
 * Pure and router-free on purpose. `LiveActivityLanesView` is asserted with
 * `renderToStaticMarkup` and has no router context, so it must be able to build
 * an href without a hook; `frontend.tsx` mounts `BrowserRouter` with no
 * basename, so plain absolute paths are the correct form.
 *
 * Every parameter is written through `URLSearchParams`, so a project name
 * containing `&`, `?`, `#`, `/` or spaces survives the round trip — and, since
 * the wire format no longer reinterprets any name, so does one called `all` or
 * `no-project`.
 */

import { hitTest, markCenterX } from "../components/overview/LiveActivityLanes";
import { type Lane, type LaneScope, markRadius } from "./live-activity";

/** Requests page with `id`'s details modal already open. */
export function requestDetailsHref(id: string): string {
	return `/requests?${new URLSearchParams({ request: id }).toString()}`;
}

/**
 * Requests page prefiltered to the requests a lane covers.
 *
 * Null for the overflow lane: it aggregates several projects, so no single
 * project filter expresses it and a link would silently show a subset.
 */
export function laneRequestsHref(scope: LaneScope): string | null {
	if (scope.kind === "other") return null;
	const params =
		scope.kind === "no-project"
			? new URLSearchParams({ noProject: "1" })
			: new URLSearchParams({ project: scope.project });
	return `/requests?${params.toString()}`;
}

/**
 * Horizontal slack, in plot px, added to a mark's radius when deciding whether
 * a click landed on it. The lane row is the generous part of the target; this
 * keeps the click honest along the axis without demanding a pinpoint hit.
 */
const CLICK_SLACK_PX = 8;

/**
 * The click contract for the plot: which request, if any, a click at
 * `(x, y)` in plot space opens.
 *
 * `hitTest` returns the nearest event in the row at ANY distance, which is what
 * a tooltip wants — the pointer is somewhere in the lane and the reader wants to
 * know what is under it. A click needs more: without a distance cap, clicking
 * empty space at the left of a busy lane would open a request minutes away from
 * the pointer. So the resolved mark only counts when the click is within its
 * drawn radius plus a little slack.
 */
export function resolveMarkHref(
	lanes: Lane[],
	x: number,
	y: number,
	now: number,
	windowMs: number,
	plotWidth: number,
): string | null {
	const hit = hitTest(lanes, x, y, now, windowMs, plotWidth);
	if (!hit) return null;

	const centre = markCenterX(hit.event.ts, now, windowMs, plotWidth);
	const reach = markRadius(hit.event.tokens) + CLICK_SLACK_PX;
	if (Math.abs(x - centre) > reach) return null;

	return requestDetailsHref(hit.event.id);
}
