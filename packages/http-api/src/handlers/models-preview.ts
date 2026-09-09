import { validateEndpointUrl } from "@clankermux/core";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@clankermux/http-common";

/** Pre-save discovery only: no account writes or client catalogue changes. */
export function createModelsPreviewHandler(
	fetchModels: typeof fetch = fetch,
	timeoutMs = 10_000,
) {
	return async (req: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return errorResponse(BadRequest("Body must be JSON"));
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) {
			return errorResponse(BadRequest("Body must be a JSON object"));
		}
		const { apiKey, endpoint } = body as Record<string, unknown>;
		if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) {
			return errorResponse(
				BadRequest("API key is required and must be a single line"),
			);
		}
		let url: URL;
		try {
			url = new URL(validateEndpointUrl(endpoint));
			if (url.username || url.password || url.search || url.hash)
				throw new Error();
			const basePath = url.pathname.replace(/\/+$/, "");
			url.pathname = `${basePath}${basePath.endsWith("/v1") ? "" : "/v1"}/models`;
		} catch {
			return errorResponse(
				BadRequest(
					"Enter an HTTP(S) base URL without credentials, query, or fragment",
				),
			);
		}
		const signal = AbortSignal.any([
			req.signal,
			AbortSignal.timeout(timeoutMs),
		]);
		try {
			const response = await fetchModels(url, {
				headers: {
					authorization: `Bearer ${apiKey.trim()}`,
					accept: "application/json",
				},
				signal,
				redirect: "error",
			});
			if (!response.ok) {
				await response.body?.cancel();
				// An upstream 401 must not sign the user out of the dashboard.
				return jsonResponse(
					{
						error:
							response.status === 401 || response.status === 403
								? "Endpoint rejected the API key. Check its credentials and permissions."
								: `Model discovery failed (upstream HTTP ${response.status}).`,
					},
					502,
				);
			}
			const payload: unknown = await response.json();
			const data =
				payload && typeof payload === "object" && "data" in payload
					? payload.data
					: null;
			if (!Array.isArray(data)) throw new Error();
			const models = new Map<string, { id: string; displayName: string }>();
			for (const item of data) {
				if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
				const id = item.id.trim();
				models.set(id, {
					id,
					displayName:
						typeof item.name === "string" && item.name.trim()
							? item.name.trim()
							: id,
				});
			}
			if (!models.size)
				return jsonResponse(
					{ error: "The endpoint returned no usable models." },
					502,
				);
			return jsonResponse({ models: [...models.values()] });
		} catch {
			// Never expose upstream bodies/errors: they may echo credentials.
			return jsonResponse(
				{
					error: signal.aborted
						? "Model discovery timed out or was cancelled."
						: "Could not read models from this endpoint. Check the URL and try again.",
				},
				502,
			);
		}
	};
}
