/**
 * Helpers for "the whole card is clickable" rows.
 *
 * A clickable row carries its handler on the container so any dead space in the
 * card opens the detail view, but the card also holds real controls (copy,
 * filter chips, action buttons). Making every one of those call
 * `stopPropagation` works only until someone adds the next child and forgets,
 * so the container asks these helpers whether the click was meant for it.
 */

/**
 * Anything that owns its own click. `[data-row-ignore]` opts a whole region
 * out: a disabled control has `pointer-events: none`, so clicks over it land on
 * whatever wraps it, and without the marker an action strip would activate the
 * row the moment one of its buttons went into a loading state.
 */
const INTERACTIVE_SELECTOR = [
	"button",
	"a[href]",
	"input",
	"select",
	"textarea",
	"label",
	"[data-row-ignore]",
	'[role="button"]',
	'[role="link"]',
	'[role="checkbox"]',
	'[role="switch"]',
	'[role="menuitem"]',
	'[role="tab"]',
].join(", ");

/**
 * True when the click landed on the container's own surface rather than on a
 * control nested inside it.
 *
 * The test is "no interactive element strictly between the target and the
 * container". An interactive ancestor at or above the container is deliberately
 * ignored, so this works whether or not the container itself is interactive.
 */
export function isRowSurfaceTarget(
	target: EventTarget | null,
	container: Element,
): boolean {
	if (!(target instanceof Element)) return false;
	if (!container.contains(target)) return false;
	const interactive = target.closest(INTERACTIVE_SELECTOR);
	if (interactive === null || interactive === container) return true;
	return !container.contains(interactive);
}

/**
 * True when the user has drag-selected text touching the row. A plain click
 * collapses any pre-existing selection at mousedown, so a live selection by the
 * time `click` fires means the pointer was used to select, not to activate.
 *
 * Intersection, not `contains(anchorNode)`: a selection dragged from one row
 * into the next has its anchor in the first row and releases the mouse over the
 * second, and an anchor test would let that mouse-up open the second row.
 */
export function hasSelectionWithin(
	container: Element,
	selection: Selection | null,
): boolean {
	// No text check beyond `isCollapsed`: a whitespace-only selection is still a
	// drag, and trimming it away would let that drag land as an activation.
	if (!selection || selection.isCollapsed) return false;
	for (let i = 0; i < selection.rangeCount; i++) {
		if (selection.getRangeAt(i).intersectsNode(container)) return true;
	}
	return false;
}

/** Composed guard for a row container's `onClick`. */
export function isRowActivationClick(
	target: EventTarget | null,
	container: Element,
	selection: Selection | null,
): boolean {
	if (hasSelectionWithin(container, selection)) return false;
	return isRowSurfaceTarget(target, container);
}
