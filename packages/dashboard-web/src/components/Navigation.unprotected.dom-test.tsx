import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { type AuthStatus, api } from "../api";
import { ThemeProvider } from "../contexts/theme-context";
import { Navigation } from "./navigation";
import { SET_PASSWORD_COMMAND } from "./UnprotectedApiNotice";

/**
 * Where the "this deployment has no management password" warning lives now.
 *
 * It used to be a full-width bar rendered by `AuthGate` above every page; it is
 * a sidebar card driven by the same `configured === false` signal. The
 * property under test is unchanged and is the whole reason the notice exists:
 * an unprotected deployment tells the operator so, and shows the exact command
 * that fixes it.
 *
 * The negative cases matter as much as the positive one. `useAuthStatus` has
 * three outcomes, and only one of them means "unprotected" — a notice rendered
 * while the probe is in flight would flash on every load, and one rendered on a
 * failed probe would accuse the operator whenever the server is merely
 * unreachable.
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
const restores: Array<() => void> = [];

/**
 * Never resolves. Models the in-flight probe: React Query stays `pending` for
 * the life of the test, which is the state the notice must stay silent in.
 */
function never<T>(): Promise<T> {
	return new Promise<T>(() => {});
}

async function mount(status: AuthStatus | Error | "pending"): Promise<void> {
	const statusSpy = spyOn(api, "getAuthStatus").mockImplementation(async () => {
		if (status === "pending") return never<AuthStatus>();
		if (status instanceof Error) throw status;
		return status;
	});
	restores.push(() => {
		statusSpy.mockRestore();
	});

	// The sidebar's other two footer panels are not under test. Both are given a
	// failure so they render their own "unavailable" states rather than reaching
	// the network: `SidebarStatus` via the api singleton, and the update check
	// via the raw `fetch` the navigation makes on mount.
	const systemSpy = spyOn(api, "getSystemStatus").mockImplementation(() => {
		throw new Error("not under test");
	});
	restores.push(() => {
		systemSpy.mockRestore();
	});

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ status: "unknown" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	restores.push(() => {
		globalThis.fetch = realFetch;
	});

	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchInterval: false } },
	});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<ThemeProvider>
					<MemoryRouter>
						<Navigation />
					</MemoryRouter>
				</ThemeProvider>
			</QueryClientProvider>,
		);
	});
	// Let the status query settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function notice(): HTMLElement | null {
	const candidates = host?.querySelectorAll('[role="status"]') ?? [];
	for (const el of candidates) {
		if (el.textContent?.includes("unprotected")) return el as HTMLElement;
	}
	return null;
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
	while (restores.length > 0) restores.pop()?.();
});

describe("no management password configured", () => {
	it("tells the operator, in the sidebar", async () => {
		await mount({ configured: false, authenticated: false });
		const el = notice();
		expect(el).not.toBeNull();
		expect(el?.textContent).toContain("Management API unprotected");
	});

	it("states the exposure and shows the exact command", async () => {
		await mount({ configured: false, authenticated: false });
		const el = notice();
		// The substance, not just the headline: what an attacker on this port
		// can do, and the one command that closes it.
		expect(el?.textContent).toContain("read and change every account");
		expect(el?.textContent).toContain(SET_PASSWORD_COMMAND);
	});

	it("keeps the command selectable and monospaced", async () => {
		await mount({ configured: false, authenticated: false });
		const code = notice()?.querySelector("code");
		expect(code?.textContent).toBe(SET_PASSWORD_COMMAND);
		// Copying it is the entire point of the box.
		expect(code?.className).toContain("select-all");
		expect(code?.className).toContain("font-mono");
	});

	it("offers no button — not a setter, and not a dismiss", async () => {
		await mount({ configured: false, authenticated: false });
		// No HTTP setter: while fail-open, an unauthenticated setter lets any LAN
		// caller win the first-set race and lock the operator out. No dismiss
		// either: it is a standing condition, and a dismissed notice would leave
		// the deployment unprotected and unmentioned.
		expect(notice()?.querySelectorAll("button")).toHaveLength(0);
	});

	it("sits above the deployment status, not below it", async () => {
		await mount({ configured: false, authenticated: false });
		const el = notice();
		expect(el).not.toBeNull();
		// A security condition outranks uptime/version info, so it heads the
		// sidebar's footer group rather than being buried under it. Compared as
		// sibling order inside that group, not as document order, so an
		// unrelated wrapper elsewhere in the tree cannot satisfy it.
		const group = Array.from(el?.parentElement?.children ?? []);
		const noticeIndex = group.indexOf(el as Element);
		const statusIndex = group.findIndex((child) =>
			child.textContent?.includes("Status"),
		);
		expect(noticeIndex).toBeGreaterThanOrEqual(0);
		expect(statusIndex).toBeGreaterThan(noticeIndex);
	});
});

describe("a password IS configured", () => {
	it("says nothing", async () => {
		await mount({ configured: true, authenticated: true });
		expect(notice()).toBeNull();
		expect(text()).not.toContain("unprotected");
	});
});

describe("the status probe has not answered yet", () => {
	it("says nothing while it is in flight", async () => {
		await mount("pending");
		// Otherwise the warning flashes on every single page load.
		expect(notice()).toBeNull();
	});

	it("says nothing when the probe failed", async () => {
		await mount(new Error("network down"));
		// An unreachable server is not a known-unprotected one.
		expect(notice()).toBeNull();
	});
});
