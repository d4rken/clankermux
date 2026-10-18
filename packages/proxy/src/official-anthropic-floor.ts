import {
	getChatContext,
	getNativeResponsesMetaContext,
	getSdkBridgeInnerMetaContext,
	type RequestMeta,
	SDK_BRIDGE_SIDE_REQUEST_FORK,
	sdkBridgeRefusedField,
	sdkBridgeSideRequestMode,
} from "@clankermux/types";
import type { ProxyContext } from "./handlers/proxy-types";
import { RoutingPolicyError } from "./resolved-route";

export interface OfficialAnthropicFloorInput {
	/** The Responses or Chat adapter marked the request in its in-process context. */
	adapterFloor: boolean;
	/** A bridge inner call: Claude Code itself, working on a bridged turn. */
	sdkBridgeInner: boolean;
	/** In-process maintenance traffic (keepalive, auto-refresh). */
	internal: boolean;
	/** The API key's `client_profiles.application`; null without a profile. */
	application: string | null;
	/** The harness this request's own headers name (`detectHarness`). */
	harness: string | null;
}

/**
 * How a request may reach an official Anthropic account. Only Claude Code on
 * a key whose profile says so goes direct; every other client is served there
 * through the SDK bridge:
 *
 *   inner call                                → direct
 *   Responses / Chat adapter                  → sdk-bridge (any key, any UA)
 *   internal maintenance                      → direct
 *   claude-code key + claude-cli UA           → direct
 *   claude-code key + curl UA                 → sdk-bridge
 *   pi key + claude-cli UA                    → sdk-bridge
 *   generic key, or no profile                → sdk-bridge
 */
export function officialAnthropicVia(
	input: OfficialAnthropicFloorInput,
): "direct" | "sdk-bridge" {
	if (input.sdkBridgeInner) return "direct";
	if (input.adapterFloor) return "sdk-bridge";
	if (input.internal) return "direct";
	return input.application === "claude-code" && input.harness === "claude-code"
		? "direct"
		: "sdk-bridge";
}

/** The only request the SDK bridge serves as a Claude Code turn. */
export function isSdkBridgeTurnRequest(meta: RequestMeta): boolean {
	return meta.method === "POST" && meta.path === "/v1/messages";
}

/**
 * The API key's destinations and profile application, read once per request
 * and kept on `meta` (`pin`, `clientApplication`). Nothing is read for an
 * internal request or one without a key.
 *
 * @throws {RoutingPolicyError} When the key is gone or its stored
 *         destinations are malformed: routing fails closed on both.
 */
export async function resolveApiKeyProfile(
	meta: RequestMeta,
	ctx: ProxyContext,
	apiKeyId: string | null,
): Promise<string | null> {
	if (meta.clientApplication !== undefined) return meta.clientApplication;
	let application: string | null = null;
	if (apiKeyId && !meta.internal) {
		const pin = await ctx.dbOps.getApiKeyPin(apiKeyId);
		if (!pin || pin.malformed)
			throw new RoutingPolicyError(
				"API key destinations are missing or invalid",
			);
		application = pin.application ?? null;
		meta.pin = {
			accountId: pin.pinnedAccountId,
			providers: pin.pinnedProviders,
			excludedProviders: pin.excludedProviders ?? null,
		};
	}
	meta.clientApplication = application;
	return application;
}

/**
 * Set `officialAnthropicVia` and `sdkBridgeRefusedField` for this request.
 * Runs before the parked-continuation lookup and before routing, both of
 * which act on them.
 */
export async function resolveOfficialAnthropicFloor(
	meta: RequestMeta,
	ctx: ProxyContext,
	apiKeyId: string | null,
	headers: Headers,
	parsedBody: unknown,
): Promise<void> {
	const sdkBridgeInner = getSdkBridgeInnerMetaContext(meta) !== undefined;
	const application = sdkBridgeInner
		? null
		: await resolveApiKeyProfile(meta, ctx, apiKeyId);
	meta.officialAnthropicVia = officialAnthropicVia({
		adapterFloor:
			getNativeResponsesMetaContext(meta)?.denyDirectOfficialAnthropic ===
				true || getChatContext(meta)?.denyDirectOfficialAnthropic === true,
		sdkBridgeInner,
		internal: meta.internal === true,
		application,
		harness: meta.clientHarness ?? null,
	});
	// A side-request mode the bridge does not serve is the bridge's to refuse,
	// with its own code, whatever the body's fields.
	const sideRequestMode = sdkBridgeSideRequestMode(headers);
	meta.sdkBridgeRefusedField =
		meta.officialAnthropicVia === "sdk-bridge" &&
		(sideRequestMode === null ||
			sideRequestMode === SDK_BRIDGE_SIDE_REQUEST_FORK)
			? sdkBridgeRefusedField(parsedBody, {
					sideRequest: sideRequestMode === SDK_BRIDGE_SIDE_REQUEST_FORK,
				})
			: null;
}
