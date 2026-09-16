import { parseHttpError } from "@clankermux/errors";
import type {
	ClientFormat,
	ClientModelMetadataResponse,
} from "@clankermux/types";
export async function clientRequest<T>(
	path: string,
	body?: unknown,
	method = body === undefined ? "GET" : "POST",
): Promise<T> {
	const response = await fetch(`/api/clients${path}`, {
		method,
		...(body === undefined
			? {}
			: {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	if (!response.ok) throw await parseHttpError(response);
	return (await response.json()).data;
}

/**
 * What may be declared about this client's published models, resolved server
 * side from the routes serving them right now.
 */
export function clientModelMetadata(
	apiKeyId: string,
	format: ClientFormat,
): Promise<ClientModelMetadataResponse> {
	return clientRequest<ClientModelMetadataResponse>(
		`/${encodeURIComponent(apiKeyId)}/model-metadata?format=${encodeURIComponent(format)}`,
	);
}
