/**
 * Every client identity ClankerMux presents to Devin, one function per
 * profile: the protobuf Metadata in each Connect body, and the headers on
 * each request it originates.
 */
import {
	type DisplayOption,
	type Metadata,
	MetadataSchema,
} from "./vendor/devin-proto";
import { create } from "./vendor/protobuf";

export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** Pinned to the official CLI release (npm `@cognition-ai/cli-*` beta), inspected 2026-09-23. */
export const DEVIN_CLI_VERSION = "3000.11.1";
export const DEVIN_CLI_IDE_NAME = "devin-cli";
export const DEVIN_CLI_IDE_TYPE = "chisel";
export const DEVIN_CLI_EXTENSION_NAME = "chisel";
export const DEVIN_LOCALE = "en";

export const DEVIN_DISCOVERY_IDE_NAME = "chisel";
export const DEVIN_DISCOVERY_VERSION = "0.0.0-dev";
/** Slots 6/7/8 are present in the upstream request but not its older enum. */
export const DEVIN_DISCOVERY_MODEL_DISPLAYS: readonly DisplayOption[] =
	Object.freeze([3, 4, 6, 7, 8] as DisplayOption[]);

/** `darwin` → `darwin`, `win32` → `windows`, anything else → `linux`. */
export function devinOs(platform: NodeJS.Platform = process.platform): string {
	return platform === "darwin"
		? "darwin"
		: platform === "win32"
			? "windows"
			: "linux";
}

/** `tok` → `devin-session-token$tok`; an already-prefixed token is unchanged. */
export function devinSessionApiKey(token: string): string {
	return token.startsWith(DEVIN_SESSION_TOKEN_PREFIX)
		? token
		: `${DEVIN_SESSION_TOKEN_PREFIX}${token}`;
}

/** GetUserJwt and GetUserStatus (no user JWT yet), and GetChatMessage. */
export function devinChatMetadata(
	token: string,
	userJwt = "",
	platform: NodeJS.Platform = process.platform,
): Metadata {
	return create(MetadataSchema, {
		apiKey: devinSessionApiKey(token),
		userJwt,
		ideName: DEVIN_CLI_IDE_NAME,
		ideType: DEVIN_CLI_IDE_TYPE,
		ideVersion: DEVIN_CLI_VERSION,
		extensionName: DEVIN_CLI_EXTENSION_NAME,
		extensionVersion: DEVIN_CLI_VERSION,
		locale: DEVIN_LOCALE,
		os: devinOs(platform),
		supportedModelDisplays: [],
	});
}

/** GetCliModelConfigs. */
export function devinDiscoveryMetadata(
	token: string,
	platform: NodeJS.Platform = process.platform,
): Metadata {
	return create(MetadataSchema, {
		apiKey: devinSessionApiKey(token),
		userJwt: "",
		ideName: DEVIN_DISCOVERY_IDE_NAME,
		ideType: DEVIN_CLI_IDE_TYPE,
		ideVersion: DEVIN_DISCOVERY_VERSION,
		extensionName: DEVIN_CLI_EXTENSION_NAME,
		extensionVersion: DEVIN_DISCOVERY_VERSION,
		locale: DEVIN_LOCALE,
		os: devinOs(platform),
		supportedModelDisplays: [...DEVIN_DISCOVERY_MODEL_DISPLAYS],
	});
}

/** Connect unary RPCs: GetUserJwt, GetCliModelConfigs, GetUserStatus. */
export function devinRpcHeaders(): Record<string, string> {
	return {
		"content-type": "application/proto",
		"connect-protocol-version": "1",
		accept: "application/proto",
	};
}

/** The GetChatMessage server stream. */
export function devinChatHeaders(): Record<string, string> {
	return {
		"content-type": "application/connect+proto",
		"connect-protocol-version": "1",
		"connect-content-encoding": "gzip",
		"connect-accept-encoding": "gzip",
		"accept-encoding": "identity",
	};
}

/** Replaces every inbound client header on a proxied request. */
export function devinProxyBaseHeaders(): Record<string, string> {
	return { "content-type": "application/json" };
}

/** POST api.devin.ai/auth/cli/token */
export function devinAuthHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Accept: "application/json" };
}
