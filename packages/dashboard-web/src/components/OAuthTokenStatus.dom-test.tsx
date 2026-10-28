import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OAuthTokenStatus } from "./OAuthTokenStatus";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		host?.remove();
	} finally {
		root = null;
		host = null;
		mock.restore();
	}
});

it("sends no token-health request once unmounted", async () => {
	const requests: { path: string; signal?: AbortSignal | null }[] = [];
	spyOn(globalThis, "fetch").mockImplementation((async (
		input: unknown,
		init?: RequestInit,
	) => {
		requests.push({ path: String(input), signal: init?.signal });
		// A transport failure, so the client schedules its retry.
		throw new TypeError("Failed to fetch");
	}) as unknown as typeof fetch);
	const paths = () => requests.map((r) => r.path);

	host = document.createElement("div");
	document.body.append(host);
	const mounted = createRoot(host);
	root = mounted;
	await act(async () => {
		mounted.render(<OAuthTokenStatus accountName="acct" hasRefreshToken />);
	});
	await act(async () => mounted.unmount());
	root = null;

	expect(paths()).toEqual(["/api/token-health/account/acct"]);
	expect(requests[0]?.signal?.aborted).toBe(true);
	// Past the client's one-second retry backoff.
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	expect(paths()).toEqual(["/api/token-health/account/acct"]);
});
