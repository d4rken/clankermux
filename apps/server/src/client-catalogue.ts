import { handleModelsRequest } from "@clankermux/openai-responses-adapter";
import { ANTHROPIC_BUNDLED_MODEL_CREATED_AT } from "@clankermux/proxy";
import type { ClientCatalogue, ClientFormat } from "@clankermux/types";

export function renderClientCatalogue(
	catalogue: ClientCatalogue,
	format: ClientFormat,
): Response {
	const headers = { "Cache-Control": "private, no-store" };
	if (format === "codex") {
		const known = catalogue.models.filter(
			(model) => model.codexMetadata?.slug === model.targetModel,
		);
		if (known.length || catalogue.models.length === 0) {
			const models = known.map((model) => ({
				...model.codexMetadata,
				slug: model.id,
				display_name: model.displayName,
			}));
			return Response.json({ ...catalogue.envelope, models }, { headers });
		}
	}
	if (format === "anthropic") {
		const data = catalogue.models.map((model) => ({
			type: "model",
			id: model.id,
			display_name: model.displayName,
			created_at: model.createdAt ?? ANTHROPIC_BUNDLED_MODEL_CREATED_AT,
		}));
		return Response.json(
			{
				data,
				has_more: false,
				first_id: data[0]?.id ?? null,
				last_id: data.at(-1)?.id ?? null,
			},
			{ headers },
		);
	}
	const response = handleModelsRequest(
		catalogue.models.map((model) => model.id),
	);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export function readCodexEnvelope(raw: { bodyText: string } | null): {
	models: Array<Record<string, unknown> & { slug: string }>;
	[key: string]: unknown;
} | null {
	if (!raw) return null;
	try {
		const body = JSON.parse(raw.bodyText);
		if (
			!body ||
			!Array.isArray(body.models) ||
			body.models.some(
				(m: unknown) =>
					!m ||
					typeof m !== "object" ||
					typeof (m as { slug?: unknown }).slug !== "string",
			)
		)
			return null;
		return body;
	} catch {
		return null;
	}
}
export async function catalogueWithin<T>(
	work: Promise<T>,
	fallback: T,
	ms: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.catch(() => fallback),
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
