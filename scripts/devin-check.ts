#!/usr/bin/env bun
/** Read-only account discovery; --smoke also spends a small amount of included quota. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Account } from "@clankermux/types";
import { DevinProvider, devinClient } from "../packages/providers/src/index";

const path = resolve(import.meta.dir, "../.cache/devin-login/credentials.json");
const { token } = JSON.parse(await readFile(path, "utf8"));
if (typeof token !== "string" || !token)
	throw new Error("Run scripts/devin-login.ts first");
const info = await devinClient.getAccount(token);
console.log(
	JSON.stringify(
		{
			plan: info.usage.planName,
			canUseCli: info.usage.canUseCli,
			daily: info.usage.daily,
			weekly: info.usage.weekly,
			models: info.models.map(({ id, disabled, disabledReason }) => ({
				id,
				disabled,
				disabledReason,
			})),
		},
		null,
		2,
	),
);
if (process.argv.includes("--smoke")) {
	const modelFlag = process.argv.indexOf("--model");
	const requestedModel = modelFlag < 0 ? "" : process.argv[modelFlag + 1];
	if (!requestedModel || requestedModel.startsWith("--"))
		throw new Error("--smoke requires --model <discovered model ID>");
	const model = devinClient.resolveModel(info.models, requestedModel);
	const provider = new DevinProvider();
	const account = {
		id: "devin-local-smoke",
		provider: "devin",
		api_key: token,
		custom_endpoint: null,
		auto_pause_on_overage_enabled: true,
	} as Account;
	const messages: unknown[] = [
		{
			role: "user",
			content: "Call report_sum once with value 5. Do not explain.",
		},
	];
	const tools = [
		{
			name: "report_sum",
			description: "Report the sum",
			input_schema: {
				type: "object",
				properties: { value: { type: "integer" } },
				required: ["value"],
			},
		},
	];
	const invoke = async (choice: object) => {
		const request = await provider.transformRequestBody(
			new Request(provider.buildUrl("/v1/messages", "", account), {
				method: "POST",
				signal: AbortSignal.timeout(180000),
				body: JSON.stringify({
					model: model.id,
					max_tokens: 256,
					stream: false,
					messages,
					tools,
					tool_choice: choice,
				}),
			}),
			account,
		);
		if (request.headers.get("x-clankermux-synthetic-response") === "true")
			throw new Error(
				`Devin refused smoke test (${request.headers.get("x-clankermux-synthetic-status")})`,
			);
		const headers = new Headers(request.headers);
		for (const key of [...headers.keys()])
			if (key.startsWith("x-clankermux-")) headers.delete(key);
		const raw = await fetch(new Request(request.clone(), { headers }), {
			redirect: "error",
		});
		const response = await provider.normalizeUpstreamResponse(raw, request);
		if (!response.ok)
			throw new Error(`Devin smoke request failed (${response.status})`);
		return await response.json();
	};
	const first = await invoke({ type: "auto" });
	const call = first.content.find(
		(part: { type: string }) => part.type === "tool_use",
	);
	if (!call || call.name !== "report_sum" || call.input?.value !== 5)
		throw new Error("Devin did not return the expected tool call");
	messages.push(
		{ role: "assistant", content: first.content },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: call.id, content: "5" },
				{ type: "text", text: "Acknowledge the result in a brief text reply." },
			],
		},
	);
	const second = await invoke({ type: "auto" });
	if (
		!second.content.some(
			(part: { type: string; text?: string }) =>
				part.type === "text" && part.text,
		)
	)
		throw new Error("Devin did not complete the tool roundtrip");
	console.log(
		JSON.stringify({
			smoke: "passed",
			model: model.id,
			firstUsage: first.usage,
			secondUsage: second.usage,
		}),
	);
}
