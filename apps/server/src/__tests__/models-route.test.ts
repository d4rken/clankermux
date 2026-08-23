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
	getCatalog: (v: string | null) => Promise<{
		bodyText: string;
		etag: string | null;
	} | null>,
) {
	const versions: Array<string | null> = [];
	return {
		versions,
		deps: {
			getCatalog: (v: string | null) => {
				versions.push(v);
				return getCatalog(v);
			},
			staticModels,
		},
	};
}

describe("handleModelsRoute", () => {
	test("serves the OpenAI list shape when no client_version is present", async () => {
		const { deps: d, versions } = deps(async () => ({
			bodyText: CATALOG_BODY,
			etag: null,
		}));

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models"),
			d,
		);
		const body = (await resp.json()) as { object?: string };

		expect(resp.status).toBe(200);
		expect(body.object).toBe("list");
		// The catalog is never even consulted for a non-Codex client.
		expect(versions).toHaveLength(0);
	});

	test("serves the Codex catalog verbatim when client_version is present", async () => {
		const { deps: d, versions } = deps(async () => ({
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
		expect(versions).toEqual(["0.149.0"]);
	});

	test("omits the ETag header when upstream sent none", async () => {
		const { deps: d } = deps(async () => ({
			bodyText: CATALOG_BODY,
			etag: null,
		}));

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version=0.149.0"),
			d,
		);
		expect(resp.headers.has("ETag")).toBe(false);
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

	// The value becomes a cache key and is forwarded upstream on an authenticated
	// call to chatgpt.com, so an unconstrained one lets a caller mint unlimited
	// distinct keys — every one a cache miss and a fresh upstream request on a
	// real account's OAuth bearer.
	test("refuses to forward a client_version that is not a dotted release", async () => {
		const { deps: d, versions } = deps(async () => ({
			bodyText: CATALOG_BODY,
			etag: null,
		}));

		for (const bogus of [
			"0.149.0; DROP",
			"../../etc/passwd",
			"9".repeat(4096),
			"latest",
			"0.149.0-beta",
			"v0.149.0",
			"0.0.0.0.0",
		]) {
			await handleModelsRoute(
				new URL(
					`http://proxy.local/v1/models?client_version=${encodeURIComponent(bogus)}`,
				),
				d,
			);
		}

		// Still Codex-shaped requests — they just collapse onto the shared
		// unversioned entry instead of each minting a key of their own.
		expect(versions).toEqual([null, null, null, null, null, null, null]);
	});

	test("forwards well-formed release numbers unchanged", async () => {
		const { deps: d, versions } = deps(async () => ({
			bodyText: CATALOG_BODY,
			etag: null,
		}));

		for (const good of ["0.149.0", "1", "0.149", "2026.8.69"]) {
			await handleModelsRoute(
				new URL(`http://proxy.local/v1/models?client_version=${good}`),
				d,
			);
		}

		expect(versions).toEqual(["0.149.0", "1", "0.149", "2026.8.69"]);
	});

	// Presence selects the shape; the value is only what gets forwarded upstream.
	// An empty parameter is still a Codex-shaped request.
	test("treats an empty client_version as present but forwards no version", async () => {
		const { deps: d, versions } = deps(async () => ({
			bodyText: CATALOG_BODY,
			etag: null,
		}));

		const resp = await handleModelsRoute(
			new URL("http://proxy.local/v1/models?client_version="),
			d,
		);

		expect(await resp.text()).toBe(CATALOG_BODY);
		expect(versions).toEqual([null]);
	});
});
