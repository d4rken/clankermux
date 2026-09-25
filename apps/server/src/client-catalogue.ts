import { ALIAS_ADVERTISED_EFFORTS } from "@clankermux/core";
import { handleModelsRequest } from "@clankermux/openai-responses-adapter";
import { ANTHROPIC_BUNDLED_MODEL_CREATED_AT } from "@clankermux/proxy";
import {
	type ClientCatalogue,
	type ClientFormat,
	type ClientModel,
	type ClientModelMetadata,
	type ClientModelMetadataMap,
	SUPPORTED_PI_PROMPT_VERSIONS,
} from "@clankermux/types";

/**
 * A reusable alias has no single model's prompt or optional API features.
 * Supply Codex's required ModelInfo fields using neutral client configuration;
 * only substantiated common limits/modalities describe the backends. Keep this
 * independent of cached metadata belonging to any one target: the effort
 * levels are the fixed alias range, so they survive a metadata lookup that
 * failed or overran its budget.
 * Wire schema: codex-rs/protocol/src/openai_models.rs, ModelInfo (0.149+).
 */
export function aliasCodexMetadata(
	model: Pick<ClientModel, "targetModel" | "displayName">,
	metadata?: ClientModelMetadata,
): Record<string, unknown> {
	return {
		slug: model.targetModel,
		display_name: model.displayName,
		description: "Model alias with ordered availability fallbacks",
		base_instructions: "You are a coding assistant.",
		supported_reasoning_levels: ALIAS_ADVERTISED_EFFORTS.map((effort) => ({
			effort,
			description:
				"Accepted by the alias; mapped to the selected fallback target",
		})),
		default_reasoning_level: "medium",
		shell_type: "shell_command",
		visibility: "list",
		supported_in_api: true,
		priority: 0,
		availability_nux: null,
		upgrade: null,
		supports_reasoning_summaries: false,
		supports_reasoning_summary_parameter: false,
		support_verbosity: false,
		default_verbosity: null,
		apply_patch_tool_type: null,
		truncation_policy: { mode: "bytes", limit: 10000 },
		experimental_supported_tools: [],
		input_modalities: metadata?.inputModalities ?? ["text"],
		...(metadata?.contextWindow === undefined
			? {}
			: {
					context_window: metadata.contextWindow,
					max_context_window: metadata.contextWindow,
				}),
	};
}

export function renderClientCatalogue(
	catalogue: ClientCatalogue,
	format: ClientFormat,
	metadata?: ClientModelMetadataMap,
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
				...(metadata ? { clankermux: metadata[model.id] ?? {} } : {}),
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
			...(metadata ? { clankermux: metadata[model.id] ?? {} } : {}),
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
		metadata,
		// pi reads it to warn before a Claude turn on the SDK bridge is refused.
		metadata
			? { piPromptVersions: [...SUPPORTED_PI_PROMPT_VERSIONS] }
			: undefined,
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
