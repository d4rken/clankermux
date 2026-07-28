/**
 * Re-entrancy guard for form submits that create server-side state.
 *
 * The latch is a MUTABLE REF CELL, never React state. React state updates are
 * not synchronous: two clicks dispatched before the next render would both
 * observe `isSubmitting === false` and both fire, creating a duplicate account
 * row or a duplicate device/OAuth session. A ref flips in the same tick as the
 * first click, so the second call sees it.
 *
 * `setSubmitting` exists only so the caller can render `disabled` — it is a
 * presentation mirror, never the guard.
 *
 * Both are cleared in `finally`, so a failed attempt can be retried
 * immediately, and the guard survives the early `return`s that these handlers
 * are full of (it wraps the whole handler rather than latching inline).
 */
export async function runGuarded(
	latch: { current: boolean },
	setSubmitting: (submitting: boolean) => void,
	submit: () => Promise<void>,
): Promise<void> {
	if (latch.current) return;
	latch.current = true;
	setSubmitting(true);
	try {
		await submit();
	} finally {
		latch.current = false;
		setSubmitting(false);
	}
}
