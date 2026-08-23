import { describe, expect, test } from "bun:test";
import { handleModelsRoute } from "../models-route";

const CATALOG_BODY =
	'{"models":[{"slug":"gpt-5.6-sol","context_window":272000}]}';

function staticModels(): Response {
	return new Response(JSON.stringify({ object: "list", data: [{ id: "x" }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function deps(
	getCatalog: (apiKeyId: string | null) => Promise<{
		bodyText: string;
		etag: string | null;
	} | null>,
) {
	const keys: Array<string | null> = [];
	return {
		keys,
		deps: {
			getCatalog: (apiKeyId: string | null) => {
				keys.push(apiKeyId);
				return getCatalog(apiKeyId);
			},
			staticModels,
		},
	};
}

const catalog = async () => ({ bodyText: CATALOG_BODY, etag: null });

describe("handleModelsRoute", () => {
	test("serves the OpenAI list shape when no client_version is present", async () => {
		const { deps: d, keys } = deps(catalog);

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models"),
			d,
		);
		const body = (await resp.json()) as { object?: string };

		expect(resp.status).toBe(200);
		expect(body.object).toBe("list");
		// The catalog is never even consulted for a non-Codex client.
		expect(keys).toHaveLength(0);
	});

	test("serves the Codex catalog verbatim when client_version is present", async () => {
		const { deps: d } = deps(async () => ({
			bodyText: CATALOG_BODY,
			etag: 'W/"abc"',
		}));

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
		);

		expect(resp.status).toBe(200);
		expect(resp.headers.get("Content-Type")).toBe("application/json");
		expect(resp.headers.get("ETag")).toBe('W/"abc"');
		expect(await resp.text()).toBe(CATALOG_BODY);
	});

	test("omits the ETag header when upstream sent none", async () => {
		const { deps: d } = deps(catalog);

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
		);
		expect(resp.headers.has("ETag")).toBe(false);
	});

	// Entitlement is per-subscription, so the catalog has to be chosen for the
	// key that asked, not for the pool at large.
	test("passes the API key id through to the catalog lookup", async () => {
		const { deps: d, keys } = deps(catalog);

		await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
			"key-42",
		);
		await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
		);

		expect(keys).toEqual(["key-42", null]);
	});

	// The value is never read — only its presence. Forwarding it upstream would
	// ask OpenAI for a catalog at a version this proxy does not speak, and would
	// make a client-controlled string into a cache key.
	test("ignores the client_version value entirely", async () => {
		const { deps: d, keys } = deps(catalog);

		for (const value of [
			"0.149.0",
			"",
			"latest",
			"9".repeat(4096),
			"../../etc/passwd",
		]) {
			const resp = await handleModelsRoute(
				new URL(
					`http://proxy.local/v1/models?client_version=${encodeURIComponent(value)}`,
				),
				d,
				"key-1",
			);
			expect(await resp.text()).toBe(CATALOG_BODY);
		}

		// Every one reached the same lookup, keyed only by the API key.
		expect(keys).toEqual(["key-1", "key-1", "key-1", "key-1", "key-1"]);
	});

	// The whole point of the fallback: a Codex startup must never be blocked by
	// our inability to read a catalog. It gets a 200 it cannot use and falls back
	// to its built-in catalog, exactly as it did before this route existed.
	test("falls back to the OpenAI list shape with a 200 when no catalog is available", async () => {
		const { deps: d } = deps(async () => null);

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
		);
		const body = (await resp.json()) as { object?: string };

		expect(resp.status).toBe(200);
		expect(body.object).toBe("list");
	});

	test("falls back rather than propagating a catalog lookup throw", async () => {
		const { deps: d } = deps(async () => {
			throw new Error("unexpected");
		});

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
		);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as { object?: string }).object).toBe("list");
	});
});
