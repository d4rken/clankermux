import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthorizationHandoff } from "./AuthorizationHandoff";

/**
 * What each Copy button actually puts on the clipboard, captured at the moment
 * `execCommand("copy")` runs — the same technique as `lib/clipboard.dom-test.ts`,
 * and the only instant that decides what gets copied.
 *
 * Static markup can prove both buttons exist; it cannot prove they are wired to
 * the right values. A swapped pair of `value` props would render identically
 * and copy the wrong string, which is exactly the failure this catches.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AUTH_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=abc123&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback";
const USER_CODE = "ABCD-1234";

let copied: string | null = null;
const originalExecCommand = (document as unknown as { execCommand?: unknown })
	.execCommand;
(document as unknown as { execCommand: (c: string) => boolean }).execCommand = (
	command: string,
) => {
	if (command !== "copy") return false;
	copied =
		(document.activeElement as HTMLTextAreaElement | null)?.value ?? null;
	return true;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(): Promise<void> {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(<AuthorizationHandoff url={AUTH_URL} userCode={USER_CODE} />);
	});
}

function buttonByTitle(title: string): HTMLButtonElement {
	const button = document.querySelector<HTMLButtonElement>(
		`button[title="${title}"]`,
	);
	if (!button) throw new Error(`no button titled "${title}"`);
	return button;
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	host?.remove();
	host = null;
	copied = null;
});

afterAll(() => {
	(document as unknown as { execCommand: unknown }).execCommand =
		originalExecCommand;
});

describe("AuthorizationHandoff — copy buttons", () => {
	it("copies the authorization URL verbatim", async () => {
		await mount();
		await act(async () => {
			buttonByTitle("Copy authorization link").click();
		});

		expect(copied).toBe(AUTH_URL);
	});

	it("copies the user code, not the URL", async () => {
		await mount();
		await act(async () => {
			buttonByTitle("Copy user code").click();
		});

		expect(copied).toBe(USER_CODE);
	});
});
