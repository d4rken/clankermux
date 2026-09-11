import type { DevinAccountInfo } from "@clankermux/providers";
import { encodeConnect } from "../../../providers/src/providers/devin/connect";
import {
	GetChatMessageResponseSchema,
	StopReason,
} from "../../../providers/src/providers/devin/vendor/devin-proto";
import {
	create,
	toBinary,
} from "../../../providers/src/providers/devin/vendor/protobuf";

export function devinInfo(): DevinAccountInfo {
	return {
		userJwt: "test-jwt-secret",
		endpoint: "https://server.codeium.com",
		models: [
			{
				id: "swe-2-high",
				name: "SWE-2 High",
				disabled: false,
				disabledReason: null,
				contextWindow: 200000,
				maxTokens: 64000,
				supportsImages: false,
				defaultInFamily: true,
				effort: "high",
			},
		],
		usage: {
			kind: "devin",
			quotaBased: true,
			daily: { utilization: 20, resetAt: Date.now() + 3600000 },
			weekly: null,
			planName: "Free",
			email: null,
			accountId: null,
			canUseCli: true,
			overageBalanceUsd: 0,
			includedCreditsRemaining: null,
		},
	};
}
export function devinReply(quota = false): Response {
	const body = quota
		? encodeConnect(
				new TextEncoder().encode(
					'{"error":{"code":"resource_exhausted","message":"Quota exhausted"}}',
				),
				2,
			)
		: Buffer.concat([
				encodeConnect(
					toBinary(
						GetChatMessageResponseSchema,
						create(GetChatMessageResponseSchema, {
							deltaText: "hello from SWE-2",
							stopReason: StopReason.STOP_PATTERN,
						}),
					),
				),
				encodeConnect(new TextEncoder().encode("{}"), 2),
			]);
	return new Response(new Uint8Array(body), {
		headers: { "content-type": "application/connect+proto" },
	});
}
