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
/** A Pi client, the shape whose recipe declares per-model entries. */
const piClient = {
	apiKeyId: "key",
	application: "pi",
	key: { name: "CNC dev" },
	catalogues: {
		openai: {
			defaultModel: "gpt-6-astra",
			models: [
				{
					id: "gpt-6-astra",
					displayName: "Astra",
					targetModel: "gpt-6-astra",
					accountIds: null,
				},
			],
		},
	},
} as unknown as ClientView;
async function mount(apiKey?: string, which: ClientView = client) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<ClientSetupDialog
				client={which}
				initialApiKey={apiKey}
				onClose={() => {
					root?.render(null);
				}}
			/>,
		);
	});
}
/** Route by URL: the dialog may ask for the key, the metadata, or both. */
function routes(handlers: {
	setupKey?: (init?: RequestInit) => Response;
	metadata?: () => Response;
}) {
	return mockFetch(async (input, init) => {
		const url = String(input);
		if (url.includes("/model-metadata"))
			return (
				handlers.metadata?.() ??
				Response.json({
					data: { models: {}, catalogueLoaded: true, catalogueStale: false },
				})
			);
		return (
			handlers.setupKey?.(init) ?? Response.json({ data: { apiKey: null } })
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
		// biome-ignore lint/style/noNonNullAssertion: the dialog is in its paste-the-existing-key state, which renders #existing-client-key
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

	it("declares resolved limits in a Pi snippet, key fetched or handed in", async () => {
		const metadata = () =>
			Response.json({
				data: {
					models: { "gpt-6-astra": { contextWindow: 872_000 } },
					catalogueLoaded: true,
					catalogueStale: false,
				},
			});
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			routes({
				setupKey: () => Response.json({ data: { apiKey: "btr-pi-secret" } }),
				metadata,
			}),
		);
		await mount(undefined, piClient);
		expect(
			fetch.mock.calls
				.map((call) => String(call[0]))
				.some((url) => url.includes("/model-metadata?format=openai")),
		).toBe(true);
		expect(document.querySelector("pre")?.textContent).toContain(
			'"contextWindow": 872000',
		);
		await click("Done");
		host?.remove();

		// A newly created client hands its key in, so the key effect returns early
		// — the metadata must still be fetched.
		fetch.mockClear();
		await mount("btr-new-secret", piClient);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(document.querySelector("pre")?.textContent).toContain(
			'"contextWindow": 872000',
		);
	});

	it("says so and declares nothing when the limits cannot be resolved", async () => {
		const unresolved = [
			() => Response.json({ error: "Unavailable" }, { status: 503 }),
			() => Response.json({ data: { catalogueLoaded: true } }),
			// The server's own timeout fallback: an empty map, honestly flagged.
			() =>
				Response.json({
					data: { models: {}, catalogueLoaded: false, catalogueStale: false },
				}),
		];
		for (const metadata of unresolved) {
			spyOn(globalThis, "fetch").mockImplementation(routes({ metadata }));
			await mount("btr-new-secret", piClient);
			const snippet = document.querySelector("pre")?.textContent;
			expect(snippet).toContain('"id": "gpt-6-astra"');
			expect(snippet).not.toContain("contextWindow");
			expect(document.body.textContent).toContain(
				"Model limits could not be resolved",
			);
			await act(async () => root?.unmount());
			host?.remove();
		}
	});

	it("hands over the key while the model limits are still resolving", async () => {
		// The key is the one thing the dialog exists to deliver; the limits are a
		// separate enrichment of the snippet. A slow or hung /model-metadata must
		// not withhold the key and its copy button.
		spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (input) => {
				const url = String(input);
				// Never settles: the metadata request is still in flight.
				if (url.includes("/model-metadata"))
					return await new Promise<Response>(() => {});
				return Response.json({ data: { apiKey: "btr-pending-secret" } });
			}),
		);
		await mount(undefined, piClient);
		// Precondition: the lookup really is still outstanding.
		expect(document.querySelector('[role="status"]')?.textContent).toContain(
			"Resolving model limits",
		);
		expect(document.body.textContent).toContain("btr-pending-secret");
		expect(
			[...document.querySelectorAll("button")].some(
				(b) => b.textContent?.trim() === "Copy key",
			),
		).toBe(true);
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
