/**
 * The refresh-usage endpoint reports a FAILED refresh as HTTP 200 with
 * `success: false` in the body (the request itself was handled; the upstream
 * usage read is what failed). A caller that only catches transport errors
 * therefore renders a silent no-op for every real failure — a 401 from the
 * upstream usage endpoint looked exactly like a successful refresh.
 *
 * This maps that body onto the dashboard's error surface: a string to display,
 * or null when there is nothing to report.
 */
export function resolveRefreshUsageError(res: {
	success: boolean;
	message?: string;
}): string | null {
	if (res.success) return null;
	return res.message || "Usage refresh failed";
}
