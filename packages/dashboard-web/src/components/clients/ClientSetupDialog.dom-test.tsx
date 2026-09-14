import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mockFetch } from "@clankermux/test-support";
import type { ClientView } from "@clankermux/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClientSetupDialog } from "./ClientSetupDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const client = {
	apiKeyId: "key",
	application: "claude-code",
	key: { name: "CNC" },
	catalogues: { anthropic: { models: [], defaultModel: null } },
} as unknown as ClientView;
async function mount(apiKey?: string) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<ClientSetupDialog
				client={client}
				initialApiKey={apiKey}
				onClose={() => {
					root?.render(null);
				}}
			/>,
		);
	});
}
async function click(text: string) {
	const button = [...document.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === text,
	);
	if (!button) throw new Error(`Missing ${text}`);
	await act(async () => {
		button.click();
	});
}
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	mock.restore();
});
describe("client setup credentials", () => {
	it("loads the saved key on open, prefills settings, and removes it on close", async () => {
		const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ data: { apiKey: "btr-saved-secret" } }),
		);
		await mount();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/clients/key/setup-key");
		expect(document.querySelector("pre")?.textContent).toContain(
			"btr-saved-secret",
		);
		await click("Done");
		expect(document.body.textContent).not.toContain("btr-saved-secret");
	});
	it("uses a newly generated key without refetching", async () => {
		const fetch = spyOn(globalThis, "fetch");
		await mount("btr-new-secret");
		expect(fetch).not.toHaveBeenCalled();
		expect(document.querySelector("pre")?.textContent).toContain(
			"btr-new-secret",
		);
	});
	it("remembers a pasted legacy key and then fills the recipe", async () => {
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (_input, init) =>
				Response.json({
					data: {
						apiKey: init?.method === "POST" ? "btr-legacy-secret" : null,
					},
				}),
			),
		);
		await mount();
		expect(document.body.textContent).toContain("Paste the existing key once");
		expect(document.querySelector("pre")).toBeNull();
		const input = document.querySelector<HTMLInputElement>(
			"#existing-client-key",
		)!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "btr-legacy-secret");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click("Save key");
		expect(fetch.mock.calls[1]?.[1]?.body).toBe(
			JSON.stringify({ apiKey: "btr-legacy-secret" }),
		);
		expect(document.querySelector("pre")?.textContent).toContain(
			"btr-legacy-secret",
		);
	});
	it("retries a failed key load and displays the recovered settings", async () => {
		const fetch = spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({ error: "Unavailable" }, { status: 503 }),
			)
			.mockResolvedValueOnce(
				Response.json({ data: { apiKey: "btr-recovered-key" } }),
			);
		await mount();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Unavailable",
		);
		expect(document.querySelector("pre")).toBeNull();
		await click("Retry");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(document.querySelector('[role="alert"]')).toBeNull();
		expect(document.querySelector("pre")?.textContent).toContain(
			"btr-recovered-key",
		);
	});

	it("ignores a pending retrieval after the dialog closes", async () => {
		let resolve!: (response: Response) => void;
		spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(
				() =>
					new Promise((r) => {
						resolve = r;
					}),
			),
		);
		await mount();
		await click("Done");
		await act(async () => {
			resolve(Response.json({ data: { apiKey: "late-secret" } }));
		});
		expect(document.body.textContent).not.toContain("late-secret");
	});
});
