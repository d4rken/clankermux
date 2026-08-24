import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type AuthStatus, api } from "../api";
import { AuthGate } from "./AuthGate";

/**
 * The gate that decides whether the dashboard runs at all.
 *
 * The property that matters most here is NEGATIVE and is asserted directly: on
 * a gated deployment with no session, the app's children must never mount.
 * `RequestEventProvider` opens `/api/requests/stream` and fires a protected
 * backfill query the instant it mounts, so a gate that rendered the app behind
 * a login overlay would leave a signed-out browser in an `EventSource` retry
 * loop against 401 — invisible to the operator, and permanent.
 *
 * Mounted for real rather than rendered to static markup because the whole
 * decision depends on a query resolving after the first paint.
 *
 * Stubbed with `spyOn` on the api singleton, never `mock.module`: a module mock
 * here is process-wide and its partial export set breaks every later file in
 * the DOM lane.
 */

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreStatus: (() => void) | null = null;

/** Marker child. Its presence in the DOM means the app mounted. */
function AppMarker(): ReactNode {
	return <div data-testid="app-mounted">the app</div>;
}

async function mount(status: AuthStatus | Error): Promise<void> {
	const spy = spyOn(api, "getAuthStatus").mockImplementation(async () => {
		if (status instanceof Error) throw status;
		return status;
	});
	restoreStatus = () => {
		spy.mockRestore();
	};

	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchInterval: false } },
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<AuthGate>
					<AppMarker />
				</AuthGate>
			</QueryClientProvider>,
		);
	});
	// Let the status query settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function appMounted(): boolean {
	return host?.querySelector('[data-testid="app-mounted"]') !== null;
}

function text(): string {
	return host?.textContent ?? "";
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	host?.remove();
	root = null;
	host = null;
	restoreStatus?.();
	restoreStatus = null;
});

describe("gated, signed out", () => {
	it("does NOT mount the app", async () => {
		await mount({ configured: true, authenticated: false });
		// The load-bearing assertion: the children never render, so nothing
		// behind them opens a stream or fires a protected query.
		expect(appMounted()).toBe(false);
	});

	it("shows the sign-in screen instead", async () => {
		await mount({ configured: true, authenticated: false });
		expect(text()).toContain("Sign in");
		expect(host?.querySelector('input[type="password"]')).not.toBeNull();
	});

	it("offers no reset link — recovery is a shell command", async () => {
		await mount({ configured: true, authenticated: false });
		expect(text()).toContain("auth:password --clear");
		expect(host?.querySelectorAll("a")).toHaveLength(0);
	});
});

describe("gated, signed in", () => {
	it("mounts the app and nothing else", async () => {
		await mount({ configured: true, authenticated: true });
		expect(appMounted()).toBe(true);
		expect(text()).toBe("the app");
	});
});

describe("fail-open", () => {
	it("mounts the app when no password is configured", async () => {
		// An upgrade must not lock an operator out of a box that never had one.
		await mount({ configured: false, authenticated: false });
		expect(appMounted()).toBe(true);
	});

	it("renders the children ALONE — the notice belongs to the sidebar", async () => {
		await mount({ configured: false, authenticated: false });
		// The gate used to render the "unprotected" warning itself, as a
		// full-width bar above every page. It now only decides; the warning is a
		// card in the navigation sidebar's footer, driven off the same
		// `configured === false` read. That the operator is still told, and still
		// gets the command, is asserted in Navigation.unprotected.dom-test.tsx.
		expect(text()).toBe("the app");
		expect(host?.querySelectorAll("button")).toHaveLength(0);
	});
});

describe("the status probe itself failing", () => {
	it("mounts the app rather than blaming the operator for a server outage", async () => {
		await mount(new Error("network down"));
		expect(appMounted()).toBe(true);
		expect(text()).not.toContain("Sign in");
	});
});
