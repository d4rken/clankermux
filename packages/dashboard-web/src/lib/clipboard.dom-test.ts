import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyText } from "./clipboard";

/**
 * These cover the non-secure-context fallback, which is the path every copy in
 * this dashboard actually takes: it is served over plain HTTP on a non-localhost
 * host, so `navigator.clipboard` is undefined and `window.isSecureContext` is
 * false.
 *
 * The invariants are asserted *at the moment `execCommand("copy")` runs*, not
 * afterwards, because that is the only instant that decides what gets copied.
 * A textarea that is unmounted or unfocused by then copies nothing — which is
 * exactly what a surrounding Radix focus trap used to cause.
 */

type ExecState = {
	calls: number;
	mountedIn: Element | null;
	focusedTag: string | null;
	focusedValue: string | null;
	/**
	 * Whether the mounted textarea was the focused element at copy time. Computed
	 * here rather than asserted afterwards: by the time the promise resolves the
	 * textarea has been unmounted, and `contains()` on a detached node is always
	 * false regardless of what was focused during the copy.
	 */
	focusedTheTextarea: boolean;
	selection: [number | null, number | null];
};

let state: ExecState;
let result: boolean;
let originalExecCommand: unknown;

/** The last textarea appended anywhere in the document. */
function findTextarea(): HTMLTextAreaElement | null {
	const list = document.querySelectorAll("textarea");
	return (list[list.length - 1] as HTMLTextAreaElement | undefined) ?? null;
}

beforeEach(() => {
	state = {
		calls: 0,
		mountedIn: null,
		focusedTag: null,
		focusedValue: null,
		focusedTheTextarea: false,
		selection: [null, null],
	};
	result = true;
	originalExecCommand = (document as unknown as { execCommand?: unknown })
		.execCommand;
	(document as unknown as { execCommand: (c: string) => boolean }).execCommand =
		(command: string) => {
			if (command !== "copy") return false;
			state.calls += 1;
			const textarea = findTextarea();
			state.mountedIn = textarea?.parentElement ?? null;
			state.focusedTag = document.activeElement?.tagName ?? null;
			state.focusedValue =
				(document.activeElement as HTMLTextAreaElement | null)?.value ?? null;
			state.focusedTheTextarea =
				textarea !== null && document.activeElement === textarea;
			state.selection = [
				textarea?.selectionStart ?? null,
				textarea?.selectionEnd ?? null,
			];
			return result;
		};
	document.body.innerHTML = "";
});

afterEach(() => {
	(document as unknown as { execCommand: unknown }).execCommand =
		originalExecCommand;
	document.body.innerHTML = "";
});

describe("copyText fallback", () => {
	it("copies from a textarea that is still mounted and focused when execCommand runs", async () => {
		await copyText("sk-secret");

		expect(state.calls).toBe(1);
		expect(state.mountedIn).toBe(document.body);
		expect(state.focusedTag).toBe("TEXTAREA");
		expect(state.focusedValue).toBe("sk-secret");
		expect(state.focusedTheTextarea).toBe(true);
		expect(state.selection).toEqual([0, "sk-secret".length]);
	});

	it("mounts inside the supplied host so a focus trap does not steal focus first", async () => {
		// Stands in for a Radix DialogContent: a focus trap only pulls focus back
		// when the newly focused node is outside its container, so the textarea has
		// to live inside it.
		const dialog = document.createElement("div");
		const row = document.createElement("div");
		dialog.appendChild(row);
		document.body.appendChild(dialog);

		await copyText("sk-secret", row);

		// Mounted in the host and focused there at copy time: together these are
		// what a focus trap would otherwise have broken.
		expect(state.mountedIn).toBe(row);
		expect(dialog.contains(state.mountedIn)).toBe(true);
		expect(state.focusedTheTextarea).toBe(true);
	});

	it("falls back to document.body when the supplied host is detached", async () => {
		const detached = document.createElement("div");

		await copyText("sk-secret", detached);

		expect(state.mountedIn).toBe(document.body);
	});

	it("removes the textarea and restores focus to the clicked button", async () => {
		const dialog = document.createElement("div");
		const button = document.createElement("button");
		dialog.appendChild(button);
		document.body.appendChild(dialog);
		button.focus();

		await copyText("sk-secret", dialog);

		expect(document.querySelectorAll("textarea").length).toBe(0);
		expect(document.activeElement).toBe(button);
	});

	it("rejects when the copy command reports failure, and still cleans up", async () => {
		result = false;

		await expect(copyText("sk-secret")).rejects.toThrow(
			"execCommand copy failed",
		);
		expect(document.querySelectorAll("textarea").length).toBe(0);
	});
});
