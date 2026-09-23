import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { HttpError } from "@clankermux/http-common";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type AuthStatus, api } from "../api";
import { AuthGate } from "./AuthGate";

/**
 * The first-run setup screen, mounted through the real gate so a successful
 * claim or a 409 is observed the way the operator sees it: the gate re-reads
 * `/api/auth/status` and swaps the screen.
 *
 * Stubbed with `spyOn` on the api singleton, never `mock.module`.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const restores: Array<() => void> = [];
let status: AuthStatus = { configured: false, authenticated: false };

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function mount() {
	const statusSpy = spyOn(api, "getAuthStatus").mockImplementation(
		async () => status,
	);
	restores.push(() => statusSpy.mockRestore());

	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchInterval: false },
			mutations: { retry: false },
		},
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<div data-testid="app-mounted">the app</div>
				</AuthGate>
			</QueryClientProvider>,
		);
	});
	await settle();
	return statusSpy;
}

function stubSetup(impl: () => Promise<void>) {
	const spy = spyOn(api, "setupPassword").mockImplementation(impl);
	restores.push(() => spy.mockRestore());
	return spy;
}

async function type(id: string, value: string): Promise<void> {
	await act(async () => {
		const input = document.getElementById(id) as HTMLInputElement;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function fill(code: string, password: string, repeat: string) {
	await type("setup-code", code);
	await type("setup-password", password);
	await type("setup-password-repeat", repeat);
}

async function submit(): Promise<void> {
	await act(async () => {
		host
			?.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle();
}

function alertText(): string {
	return host?.querySelector('[role="alert"]')?.textContent ?? "";
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	while (restores.length > 0) restores.pop()?.();
	status = { configured: false, authenticated: false };
});

describe("setup screen", () => {
	it("claims the password with the code, exactly once", async () => {
		await mount();
		const setup = stubSetup(async () => {
			status = { configured: true, authenticated: true };
		});
		await fill("ABCD-EFGH-JKLM", "correct horse", "correct horse");
		await submit();
		expect(setup).toHaveBeenCalledTimes(1);
		expect(setup).toHaveBeenCalledWith("ABCD-EFGH-JKLM", "correct horse");
		// The gate re-read the status and the signed-in app took over.
		expect(host?.querySelector('[data-testid="app-mounted"]')).not.toBeNull();
	});

	it("keeps the button disabled until every field is filled", async () => {
		await mount();
		const button = () =>
			host?.querySelector('button[type="submit"]') as HTMLButtonElement;
		expect(button().disabled).toBe(true);
		await type("setup-code", "ABCD-EFGH-JKLM");
		await type("setup-password", "correct horse");
		expect(button().disabled).toBe(true);
		await type("setup-password-repeat", "correct horse");
		expect(button().disabled).toBe(false);
	});

	it("rejects mismatched passwords without sending anything", async () => {
		await mount();
		const setup = stubSetup(async () => {});
		await fill("ABCD-EFGH-JKLM", "correct horse", "correct horsf");
		await submit();
		expect(setup).not.toHaveBeenCalled();
		expect(alertText()).toBe("The two passwords do not match.");
	});

	it("rejects a password shorter than 8 characters without sending anything", async () => {
		await mount();
		const setup = stubSetup(async () => {});
		await fill("ABCD-EFGH-JKLM", "seven77", "seven77");
		await submit();
		expect(setup).not.toHaveBeenCalled();
		expect(alertText()).toBe("Password must be at least 8 characters.");
	});

	it("rejects a password over 1024 UTF-8 bytes without sending anything", async () => {
		await mount();
		const setup = stubSetup(async () => {});
		// 342 three-byte characters: 342 UTF-16 units, 1026 UTF-8 bytes.
		const long = "€".repeat(342);
		await fill("ABCD-EFGH-JKLM", long, long);
		await submit();
		expect(setup).not.toHaveBeenCalled();
		expect(alertText()).toBe("Password must be at most 1024 bytes (UTF-8).");
	});

	it("explains a rejected setup code", async () => {
		await mount();
		stubSetup(async () => {
			throw new HttpError(403, "Invalid setup code");
		});
		await fill("ABCD-EFGH-JKLM", "correct horse", "correct horse");
		await submit();
		expect(alertText()).toBe(
			"That setup code is not valid. Use the most recent code printed in the server output.",
		);
	});

	it("shows the server's sentence for a 400", async () => {
		await mount();
		stubSetup(async () => {
			throw new HttpError(400, "Password too long");
		});
		await fill("ABCD-EFGH-JKLM", "correct horse", "correct horse");
		await submit();
		expect(alertText()).toBe("Password too long");
	});

	it("hands over to the sign-in screen when a password already exists", async () => {
		const statusSpy = await mount();
		const readsBefore = statusSpy.mock.calls.length;
		stubSetup(async () => {
			// Someone else claimed it, or the CLI set one, since the gate last read.
			status = { configured: true, authenticated: false };
			throw new HttpError(
				409,
				"A management password is already set. Sign in instead.",
			);
		});
		await fill("ABCD-EFGH-JKLM", "correct horse", "correct horse");
		await submit();
		expect(statusSpy.mock.calls.length).toBeGreaterThan(readsBefore);
		expect(document.getElementById("management-password")).not.toBeNull();
		expect(document.getElementById("setup-code")).toBeNull();
	});
});
