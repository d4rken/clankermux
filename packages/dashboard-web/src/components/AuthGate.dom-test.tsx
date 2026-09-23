import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type AuthStatus, api } from "../api";
import { AuthGate } from "./AuthGate";

/**
 * The gate that decides whether the dashboard runs at all.
 *
 * The property that matters most here is NEGATIVE and is asserted directly:
 * whenever the gate shows a screen instead of the app (signed out, or no
 * password set yet), the app's children must never mount.
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

async function mount(
	status: AuthStatus | Error,
	children: ReactNode = <AppMarker />,
): Promise<void> {
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
				<AuthGate>{children}</AuthGate>
			</QueryClientProvider>,
		);
	});
	// Let the status query settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

let streamsOpened = 0;
let restoreEventSource: (() => void) | null = null;

/**
 * Stands in for `RequestEventProvider`: opens the request stream on mount, as
 * the real provider does. Counted through a fake `EventSource`, so a gate that
 * let it mount would show up as a non-zero count.
 */
function StreamOpener(): ReactNode {
	useEffect(() => {
		const stream = new EventSource("/api/requests/stream");
		return () => stream.close();
	}, []);
	return <div data-testid="app-mounted">the app</div>;
}

beforeEach(() => {
	streamsOpened = 0;
	const realEventSource = globalThis.EventSource;
	class CountingEventSource {
		constructor(_url: string) {
			streamsOpened += 1;
		}
		close(): void {}
	}
	globalThis.EventSource = CountingEventSource as unknown as typeof EventSource;
	restoreEventSource = () => {
		globalThis.EventSource = realEventSource;
	};
});

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
	restoreEventSource?.();
	restoreEventSource = null;
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
		expect(text()).toContain("clankermux-server auth password --clear");
		expect(text()).toContain("bun run auth:password --clear");
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

describe("no password configured", () => {
	it("shows the setup screen instead of the app", async () => {
		await mount({ configured: false, authenticated: false });
		expect(text()).toContain("Set a management password");
		expect(host?.querySelector("#setup-code")).not.toBeNull();
		expect(host?.querySelector("#setup-password")).not.toBeNull();
		expect(host?.querySelector("#setup-password-repeat")).not.toBeNull();
	});

	it("does NOT mount the app, so nothing opens the request stream", async () => {
		await mount({ configured: false, authenticated: false }, <StreamOpener />);
		expect(appMounted()).toBe(false);
		expect(streamsOpened).toBe(0);
	});

	it("offers no way past it — the only exits are the code or a shell command", async () => {
		await mount({ configured: false, authenticated: false });
		expect(text()).toContain("auth password --set");
		expect(host?.querySelectorAll("a")).toHaveLength(0);
		const buttons = [...(host?.querySelectorAll("button") ?? [])];
		expect(buttons.map((button) => button.textContent)).toEqual([
			"Set password",
		]);
	});
});

describe("the status probe itself failing", () => {
	it("mounts the app rather than blaming the operator for a server outage", async () => {
		await mount(new Error("network down"));
		expect(appMounted()).toBe(true);
		expect(text()).not.toContain("Sign in");
	});
});
