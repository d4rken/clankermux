import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Account, DevinUsageData } from "@clankermux/types";
import { BaseProvider } from "../../base";
import { localTokenCountUrl } from "../../local-token-count";
import { buildSyntheticCountTokensRequest } from "../../synthetic-count-tokens";
import { usageCache } from "../../usage-fetcher";
import {
	DEVIN_CHAT_PATH,
	DEVIN_ENDPOINT,
	DEVIN_UPSTREAM_MODEL,
	type DevinClient,
	DevinSessionAuthenticationError,
	devinClient,
	devinMetadata,
	validateDevinEndpoint,
} from "./client";
import { DevinRpcError, encodeConnect } from "./connect";
import {
	convertDevinResponse,
	devinErrorResponse,
	unwrapDevinSignature,
} from "./stream";
import {
	CacheControlType,
	ChatMessagePromptSchema,
	ChatMessageRequestType,
	ChatMessageSource,
	ChatToolCallSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	GetChatMessageRequestSchema,
	ImageDataSchema,
	PromptCacheOptionsSchema,
} from "./vendor/devin-proto";
import { create, toBinary } from "./vendor/protobuf";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new DevinRpcError("invalid_argument", "Invalid message content");
	return value as RecordValue;
}
function blocks(value: unknown): RecordValue[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value))
		throw new DevinRpcError("invalid_argument", "Expected message content");
	return value.map(record);
}
function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function content(value: unknown) {
	let prompt = "";
	const images = [];
	for (const part of blocks(value)) {
		if (part.type === "text") prompt += string(part.text);
		else if (part.type === "image") {
			const source = record(part.source);
			if (source.type !== "base64")
				throw new DevinRpcError(
					"invalid_argument",
					"Devin images require base64 data",
				);
			images.push(
				create(ImageDataSchema, {
					base64Data: string(source.data),
					mimeType: string(source.media_type),
				}),
			);
		} else
			throw new DevinRpcError(
				"invalid_argument",
				`Unsupported Devin content type: ${string(part.type)}`,
			);
	}
	return { prompt, images };
}
function stableId(value: string): string {
	const h = createHash("sha256").update(value).digest("hex").slice(0, 32);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

function buildHistory(messages: unknown, cascade: string, model: string) {
	if (!Array.isArray(messages))
		throw new DevinRpcError("invalid_argument", "messages must be an array");
	return messages.flatMap((raw, idx) => {
		const msg = record(raw);
		const parts = blocks(msg.content);
		const messageId = stableId(`${cascade}\0${idx}\0${msg.role}`);
		if (msg.role === "assistant") {
			// Opaque redacted thinking is provider-specific; retain representable history only.
			const tools = parts
				.filter((p) => p.type === "tool_use")
				.map((p) =>
					create(ChatToolCallSchema, {
						id: string(p.id),
						name: string(p.name),
						argumentsJson: JSON.stringify(p.input ?? {}),
					}),
				);
			for (const p of parts)
				if (
					!["text", "thinking", "redacted_thinking", "tool_use"].includes(
						string(p.type),
					)
				)
					throw new DevinRpcError(
						"invalid_argument",
						"Unsupported assistant content",
					);
			const prompt = parts
				.filter((p) => p.type === "text")
				.map((p) => string(p.text))
				.join("");
			const thinking = parts
				.filter((p) => p.type === "thinking")
				.map((p) => string(p.thinking))
				.join("");
			const signature =
				parts
					.map((p) => unwrapDevinSignature(model, p.signature))
					.find(Boolean) ?? "";
			if (!prompt && !thinking && !signature && tools.length === 0) return [];
			return [
				create(ChatMessagePromptSchema, {
					messageId: `bot-${messageId}`,
					source: ChatMessageSource.SYSTEM,
					prompt,
					thinking,
					signature,
					toolCalls: tools,
				}),
			];
		}
		if (msg.role !== "user")
			throw new DevinRpcError("invalid_argument", "Unsupported message role");
		const prompts = [];
		let pending: RecordValue[] = [];
		const flush = () => {
			if (pending.length) {
				prompts.push(
					create(ChatMessagePromptSchema, {
						messageId: `${messageId}-${prompts.length}`,
						source: ChatMessageSource.USER,
						...content(pending),
					}),
				);
				pending = [];
			}
		};
		for (const p of parts) {
			if (p.type === "tool_result") {
				flush();
				prompts.push(
					create(ChatMessagePromptSchema, {
						messageId: `${messageId}-${prompts.length}`,
						source: ChatMessageSource.TOOL,
						toolCallId: string(p.tool_use_id),
						toolResultIsError: p.is_error === true,
						...content(p.content ?? ""),
					}),
				);
			} else pending.push(p);
		}
		flush();
		return prompts;
	});
}

export type DevinRequestProvenance = Readonly<
	{
		accountId: string | null;
		credentialSha256: string;
		bodySha256: string;
		url: string;
		method: string;
	} & (
		| { kind: "inference"; model: string }
		| { kind: "synthetic"; status: number }
	)
>;
const requestProvenance = new WeakMap<Request, DevinRequestProvenance>();
const reportedModels = new WeakMap<Response, { model: string | null }>();
/** Read after response consumption to include actual model metadata from late frames. */
export function getDevinReportedModel(response: Response): string | null {
	return reportedModels.get(response)?.model ?? null;
}
export function getDevinRequestProvenance(
	request: Request,
): DevinRequestProvenance | null {
	return requestProvenance.get(request) ?? null;
}
async function attestRequest(
	request: Request,
	account: Account | undefined,
	detail:
		| { kind: "inference"; model: string }
		| { kind: "synthetic"; status: number },
): Promise<Request> {
	const bodySha256 = createHash("sha256")
		.update(new Uint8Array(await request.clone().arrayBuffer()))
		.digest("hex");
	requestProvenance.set(
		request,
		Object.freeze({
			...detail,
			accountId: account?.id ?? null,
			credentialSha256: createHash("sha256")
				.update(
					JSON.stringify([
						account?.api_key ?? null,
						account?.custom_endpoint ?? null,
					]),
				)
				.digest("hex"),
			bodySha256,
			url: request.url,
			method: request.method,
		}),
	);
	return request;
}

const sessionAuthenticationFailures = new WeakSet<Request>();

export function isDevinSessionAuthenticationFailure(request: Request): boolean {
	return sessionAuthenticationFailures.has(request);
}

function synthetic(
	body: unknown,
	status = 200,
	retryAfter?: string | null,
): Request {
	return new Request("https://clankermux.local/devin", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-clankermux-synthetic-response": "true",
			"x-clankermux-synthetic-status": String(status),
			...(retryAfter ? { "x-clankermux-retry-after": retryAfter } : {}),
		},
		body: JSON.stringify(body),
	});
}

export function exhaustedDevinWindow(usage: DevinUsageData): string | null {
	for (const name of ["daily", "weekly"] as const) {
		const w = usage[name];
		if (w && w.utilization >= 100) return name;
	}
	return null;
}

export class DevinProvider extends BaseProvider {
	name = "devin";
	constructor(private readonly client: DevinClient = devinClient) {
		super();
	}
	canHandle(path: string): boolean {
		return path === "/v1/messages" || path === "/v1/messages/count_tokens";
	}
	buildUrl(path: string, _query: string, account?: Account): string {
		if (path === "/v1/messages/count_tokens")
			return localTokenCountUrl(this.name);
		return `${validateDevinEndpoint(account?.custom_endpoint || DEVIN_ENDPOINT)}${DEVIN_CHAT_PATH}`;
	}
	prepareHeaders(_headers: Headers): Headers {
		return new Headers({ "content-type": "application/json" });
	}
	async refreshToken(_account: Account): Promise<never> {
		throw new Error("Devin session tokens cannot be refreshed; sign in again");
	}
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		// Bind serialized credentials and provenance to one account snapshot across awaits.
		account = account ? { ...account } : undefined;
		try {
			const path = new URL(request.url).pathname;
			if (
				path === "/v1/messages/count_tokens" ||
				path === "/devin/count_tokens"
			) {
				const result = await buildSyntheticCountTokensRequest(request);
				return await attestRequest(result, account, {
					kind: "synthetic",
					status: Number(result.headers.get("x-clankermux-synthetic-status")),
				});
			}
			const body = record(await request.json());
			if (!account?.api_key)
				throw new DevinRpcError(
					"unauthenticated",
					"Devin session token missing; sign in again",
				);
			const info = await this.client.getAccount(
				account.api_key,
				account.custom_endpoint || DEVIN_ENDPOINT,
				request.signal,
			);
			usageCache.set(account.id, info.usage);
			if (info.usage.canUseCli === false)
				throw new DevinRpcError(
					"permission_denied",
					"This Devin account does not have CLI access",
				);
			if (account.auto_pause_on_overage_enabled !== false) {
				const exhausted = exhaustedDevinWindow(info.usage);
				if (exhausted) {
					const reset = info.usage[exhausted as "daily" | "weekly"]?.resetAt;
					throw new DevinRpcError(
						"resource_exhausted",
						`Devin ${exhausted} quota exhausted; overage is disabled for this account`,
						reset ? Math.max(60, Math.ceil((reset - Date.now()) / 1000)) : 60,
					);
				}
				if (
					!info.usage.daily &&
					!info.usage.weekly &&
					!(
						info.usage.includedCreditsRemaining &&
						info.usage.includedCreditsRemaining > 0
					)
				)
					throw new DevinRpcError(
						"resource_exhausted",
						"Devin included quota is unavailable; verify the plan before enabling overage",
					);
			}
			const requested = string(body.model);
			if (!requested)
				throw new DevinRpcError(
					"invalid_argument",
					"Devin requests require a model",
				);
			const model = this.client.resolveModel(info.models, requested);
			// Full history is sent every turn; a fresh cascade prevents equal first prompts
			// from binding unrelated users or conversations on the upstream service.
			const cascade = randomUUID();
			let tools =
				body.tools == null
					? []
					: (body.tools as unknown[]).map((raw) => {
							const tool = record(raw);
							if (!tool.name || !tool.input_schema)
								throw new DevinRpcError(
									"invalid_argument",
									"Devin requires named tools with input_schema",
								);
							return create(ChatToolDefinitionSchema, {
								name: string(tool.name),
								description: string(tool.description),
								jsonSchemaString: JSON.stringify(tool.input_schema),
								strict: tool.strict === true,
							});
						});
			const choice = record(body.tool_choice ?? {});
			// The descriptor has a toolName oneof, but live named forcing produced
			// thinking-only completions. Preserve client semantics by refusing it.
			if (choice.type === "any" || choice.type === "tool")
				throw new DevinRpcError(
					"invalid_argument",
					"Devin forced tool selection is not supported; use tool_choice auto",
				);
			if (choice.type === "none") tools = [];
			const max =
				typeof body.max_tokens === "number" &&
				Number.isFinite(body.max_tokens) &&
				body.max_tokens > 0
					? Math.floor(body.max_tokens)
					: (model.maxTokens ?? 64000);
			const history = buildHistory(body.messages, cascade, model.id);
			if (history.length === 0)
				throw new DevinRpcError(
					"invalid_argument",
					"Devin requires a non-empty conversation",
				);
			if (!model.supportsImages && history.some((p) => p.images.length))
				throw new DevinRpcError(
					"invalid_argument",
					"Selected Devin model does not support images",
				);
			const wire = create(GetChatMessageRequestSchema, {
				metadata: devinMetadata(account.api_key, info.userJwt),
				prompt: body.system == null ? "" : content(body.system).prompt,
				chatMessagePrompts: history,
				chatModelUid: model.id,
				requestType: ChatMessageRequestType.CASCADE,
				plannerMode: ConversationalPlannerMode.DEFAULT,
				cascadeId: cascade,
				executionId: randomUUID(),
				tools,
				toolChoice: create(ChatToolChoiceSchema, {
					choice: { case: "optionName", value: "auto" },
				}),
				disableParallelToolCalls: choice.disable_parallel_tool_use === true,
				systemPromptCacheOptions: create(PromptCacheOptionsSchema, {
					type: CacheControlType.EPHEMERAL,
				}),
				configuration: create(CompletionConfigurationSchema, {
					numCompletions: 1n,
					maxTokens: BigInt(Math.min(max, model.maxTokens ?? max)),
					maxNewlines: 200n,
					temperature:
						typeof body.temperature === "number" ? body.temperature : 0.4,
					firstTemperature:
						typeof body.temperature === "number" ? body.temperature : 0.4,
					topK: 50n,
					topP: typeof body.top_p === "number" ? body.top_p : 1,
					stopPatterns: [
						"<|user|>",
						"<|bot|>",
						"<|context_request|>",
						"<|endoftext|>",
						"<|end_of_turn|>",
						...(Array.isArray(body.stop_sequences)
							? body.stop_sequences.filter(
									(s): s is string => typeof s === "string",
								)
							: []),
					],
					fimEotProbThreshold: 1,
				}),
			});
			const encoded = toBinary(GetChatMessageRequestSchema, wire);
			if (encoded.length > 32 * 1024 * 1024)
				throw new DevinRpcError(
					"invalid_argument",
					"Devin request exceeds size limit",
				);
			const result = new Request(info.endpoint + DEVIN_CHAT_PATH, {
				method: "POST",
				signal: request.signal,
				headers: {
					"content-type": "application/connect+proto",
					"connect-protocol-version": "1",
					"connect-content-encoding": "gzip",
					"connect-accept-encoding": "gzip",
					"accept-encoding": "identity",
					"x-clankermux-request-stream": String(body.stream === true),
					[DEVIN_UPSTREAM_MODEL]: model.id,
				},
				body: new Uint8Array(encodeConnect(gzipSync(encoded), 1)),
			});
			return await attestRequest(result, account, {
				kind: "inference",
				model: model.id,
			});
		} catch (error) {
			if (request.signal.aborted) throw error;
			const response = devinErrorResponse(error);
			const result = synthetic(
				await response.json(),
				response.status,
				response.headers.get("retry-after"),
			);
			if (error instanceof DevinSessionAuthenticationError) {
				sessionAuthenticationFailures.add(result);
			}
			return await attestRequest(result, account, {
				kind: "synthetic",
				status: response.status,
			});
		}
	}
	async normalizeUpstreamResponse(
		response: Response,
		request: Request,
	): Promise<Response> {
		if (request.headers.has("x-clankermux-synthetic-response")) {
			const retryAfter = request.headers.get("x-clankermux-retry-after");
			if (!retryAfter) return response;
			const headers = new Headers(response.headers);
			headers.set("retry-after", retryAfter);
			return new Response(response.body, { status: response.status, headers });
		}
		const evidence: { model: string | null } = { model: null };
		const normalized = await convertDevinResponse(response, {
			// Only the label on a converted response, and only when the stream
			// itself never named a model. A missing header is a bug in the request
			// path; say so rather than print a model id that may not have run.
			model: request.headers.get(DEVIN_UPSTREAM_MODEL) ?? "unknown",
			stream: request.headers.get("x-clankermux-request-stream") === "true",
			signal: request.signal,
			onReportedModel: (model) => {
				evidence.model = model;
			},
		});
		reportedModels.set(normalized, evidence);
		return normalized;
	}
}
