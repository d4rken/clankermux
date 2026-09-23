import { describe, expect, it } from "bun:test";
import {
	DEVIN_CLI_VERSION,
	DEVIN_DISCOVERY_MODEL_DISPLAYS,
	devinAuthHeaders,
	devinChatHeaders,
	devinChatMetadata,
	devinDiscoveryMetadata,
	devinOs,
	devinProxyBaseHeaders,
	devinRpcHeaders,
	devinSessionApiKey,
} from "../client-identity";
import { MetadataSchema } from "../vendor/devin-proto";
import { toJson } from "../vendor/protobuf";

describe("devinOs", () => {
	it.each([
		["linux", "linux"],
		["darwin", "darwin"],
		["win32", "windows"],
		["freebsd", "linux"],
		["android", "linux"],
	] as const)("%s → %s", (platform, os) => {
		expect(devinOs(platform)).toBe(os);
	});
});

describe("devinSessionApiKey", () => {
	it("prefixes a bare token once", () => {
		expect(devinSessionApiKey("tok")).toBe("devin-session-token$tok");
		expect(devinSessionApiKey("devin-session-token$tok")).toBe(
			"devin-session-token$tok",
		);
	});
});

describe("Devin metadata profiles", () => {
	it("chat profile", () => {
		expect(
			toJson(MetadataSchema, devinChatMetadata("tok", "jwt", "darwin")),
		).toEqual({
			ideName: "devin-cli",
			ideVersion: DEVIN_CLI_VERSION,
			ideType: "chisel",
			extensionName: "chisel",
			extensionVersion: DEVIN_CLI_VERSION,
			apiKey: "devin-session-token$tok",
			locale: "en",
			os: "darwin",
			userJwt: "jwt",
		});
	});

	it("chat profile omits an empty user JWT", () => {
		const json = toJson(MetadataSchema, devinChatMetadata("tok", "", "linux"));
		expect(json).not.toHaveProperty("userJwt");
	});

	it("discovery profile", () => {
		expect(
			toJson(MetadataSchema, devinDiscoveryMetadata("tok", "win32")),
		).toEqual({
			ideName: "chisel",
			ideVersion: "0.0.0-dev",
			ideType: "chisel",
			extensionName: "chisel",
			extensionVersion: "0.0.0-dev",
			apiKey: "devin-session-token$tok",
			locale: "en",
			os: "windows",
			supportedModelDisplays: [3, 4, 6, 7, 8],
		});
	});

	it("discovery profile does not share its display list", () => {
		const metadata = devinDiscoveryMetadata("tok", "linux");
		metadata.supportedModelDisplays.push(1);
		expect(DEVIN_DISCOVERY_MODEL_DISPLAYS as readonly number[]).toEqual([
			3, 4, 6, 7, 8,
		]);
	});
});

describe("Devin header profiles", () => {
	it("each call returns a fresh object", () => {
		for (const build of [
			devinRpcHeaders,
			devinChatHeaders,
			devinProxyBaseHeaders,
			devinAuthHeaders,
		]) {
			const first = build();
			first["x-mutated"] = "1";
			expect(build()).not.toHaveProperty("x-mutated");
		}
	});

	it("values", () => {
		expect(devinRpcHeaders()).toEqual({
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "application/proto",
		});
		expect(devinChatHeaders()).toEqual({
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
			"connect-content-encoding": "gzip",
			"connect-accept-encoding": "gzip",
			"accept-encoding": "identity",
		});
		expect(devinProxyBaseHeaders()).toEqual({
			"content-type": "application/json",
		});
		expect(devinAuthHeaders()).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json",
		});
	});
});
