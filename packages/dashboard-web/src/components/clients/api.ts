import { parseHttpError } from "@clankermux/errors";
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
