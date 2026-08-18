/**
 * Copy `text` to the clipboard, with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is undefined on plain HTTP for any host other than
 * localhost, which is how this dashboard is normally reached, so the
 * `execCommand` fallback is the path most copies actually take here.
 *
 * `host` is where the throwaway textarea gets mounted, and it matters: Radix's
 * FocusScope (used by every modal Dialog) installs a document-level `focusin`
 * listener that pulls focus straight back inside the dialog whenever it lands
 * outside. `textarea.select()` focuses the textarea synchronously, so mounting
 * it on `document.body` from inside a dialog means focus is already gone again
 * by the time `execCommand("copy")` runs, and the copy silently grabs nothing.
 * Passing a node inside the dialog keeps the focus scope satisfied. Callers
 * that aren't inside a focus trap can leave it unset.
 */
export async function copyText(
	text: string,
	host?: HTMLElement | null,
): Promise<void> {
	if (
		typeof navigator !== "undefined" &&
		navigator.clipboard &&
		window.isSecureContext
	) {
		await navigator.clipboard.writeText(text);
		return;
	}

	const mount = host?.isConnected ? host : document.body;
	// Restored explicitly below: removing the focused textarea drops focus to
	// <body>, which leaves a dialog's focus trap to fall back on focusing the
	// dialog container itself, moving focus off the button that was clicked.
	const previouslyFocused = document.activeElement;

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.setAttribute("aria-hidden", "true");
	textarea.tabIndex = -1;
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "-9999px";
	mount.appendChild(textarea);
	try {
		// Focus explicitly rather than leaning on select()'s implicit focus, which
		// isn't guaranteed across engines. `copy` acts on the focused text
		// control's selection, so an unfocused textarea copies nothing.
		// preventScroll keeps the off-screen textarea from yanking the viewport.
		textarea.focus({ preventScroll: true });
		textarea.select();
		// iOS Safari doesn't reliably select via select() alone; setSelectionRange is the standard fix.
		textarea.setSelectionRange(0, textarea.value.length);
		if (!document.execCommand("copy")) {
			throw new Error("execCommand copy failed");
		}
	} finally {
		textarea.remove();
		if (previouslyFocused instanceof HTMLElement) {
			previouslyFocused.focus();
		}
	}
}
