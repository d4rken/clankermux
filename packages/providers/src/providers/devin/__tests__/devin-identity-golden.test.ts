/**
 * The exact identity every Devin request ClankerMux originates puts on the
 * wire: headers at the fetch boundary (lower-cased name and value, sorted) and
 * the protobuf Metadata carried in each body. A change here changes what
 * Devin sees, so it must be deliberate.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import type { Account } from "@clankermux/types";
import { createDevinLogin, exchangeDevinLogin } from "../auth";
import { type DevinAccountInfo, DevinClient } from "../client";
import { DevinProvider } from "../provider";
import {
	GetChatMessageRequestSchema,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
	GetUserStatusRequestSchema,
	GetUserStatusResponseSchema,
	type Metadata,
	MetadataSchema,
} from "../vendor/devin-proto";
import { create, fromBinary, toBinary, toJson } from "../vendor/protobuf";

const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: string): void {
	Object.defineProperty(process, "platform", {
		value: platform,
		configurable: true,
	});
}

afterEach(() => {
	if (hostPlatform) Object.defineProperty(process, "platform", hostPlatform);
});

type Pairs = Array<[string, string]>;

function sortedHeaders(headers: HeadersInit | undefined): Pairs {
	return Array.from(new Headers(headers).entries()).sort(([a], [b]) =>
		a.localeCompare(b),
	);
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

const JWT_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const MODELS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const STATUS_PATH =
	"/exa.seat_management_pb.SeatManagementService/GetUserStatus";

interface UnaryCall {
	url: string;
	headers: Pairs;
	body: Uint8Array;
}

async function captureAccountLoad(
	token = "tok",
): Promise<Map<string, UnaryCall>> {
	const calls = new Map<string, UnaryCall>();
	const client = new DevinClient(async (input, init) => {
		const url = String(input);
		const path = new URL(url).pathname;
		calls.set(path, {
			url,
			headers: sortedHeaders(init?.headers),
			body: new Uint8Array(init?.body as Uint8Array),
		});
		const reply =
			path === JWT_PATH
				? toBinary(
						GetUserJwtResponseSchema,
						create(GetUserJwtResponseSchema, { userJwt: "user-jwt" }),
					)
				: path === MODELS_PATH
					? toBinary(
							GetCliModelConfigsResponseSchema,
							create(GetCliModelConfigsResponseSchema),
						)
					: toBinary(
							GetUserStatusResponseSchema,
							create(GetUserStatusResponseSchema),
						);
		return new Response(new Uint8Array(reply));
	});
	await client.getAccount(token);
	return calls;
}

function metadataJson(metadata: Metadata | undefined): unknown {
	return metadata ? toJson(MetadataSchema, metadata) : null;
}

const accountInfo: DevinAccountInfo = {
	userJwt: "user-jwt",
	endpoint: "https://server.codeium.com",
	models: [
		{
			id: "swe-2-high",
			name: "SWE-2 High",
			defaultInFamily: true,
			disabled: false,
			disabledReason: null,
			contextWindow: 200000,
			maxTokens: 64000,
			maxOutputTokens: 64000,
			supportsImages: true,
			effort: "high",
			variant: null,
		},
	],
	usage: {
		kind: "devin",
		quotaBased: true,
		daily: { utilization: 20, resetAt: Date.now() + 3_600_000 },
		weekly: null,
		planName: "Free",
		email: null,
		accountId: null,
		canUseCli: true,
		overageBalanceUsd: 0,
		includedCreditsRemaining: null,
	},
};

class StubClient extends DevinClient {
	override async getAccount() {
		return structuredClone(accountInfo);
	}
}

const account = {
	id: "one",
	name: "Devin",
	provider: "devin",
	api_key: "tok",
	auto_pause_on_overage_enabled: true,
} as Account;

/** What a Claude Code client sends; none of it may reach Devin. */
const inboundClientHeaders: Record<string, string> = {
	authorization: "Bearer client-secret",
	"x-api-key": "client-key",
	"anthropic-version": "2023-06-01",
	"anthropic-beta": "oauth-2025-04-20",
	"user-agent": "claude-cli/2.1.280 (external, cli)",
	"x-stainless-os": "Linux",
	"x-app": "cli",
	cookie: "session=abc",
	"content-type": "application/json",
	accept: "application/json",
};

async function captureChat(): Promise<Request> {
	const provider = new DevinProvider(new StubClient());
	return provider.transformRequestBody(
		new Request(provider.buildUrl("/v1/messages", "", account), {
			method: "POST",
			headers: inboundClientHeaders,
			body: JSON.stringify({
				model: "swe-2-high",
				stream: true,
				messages: [{ role: "user", content: "hello" }],
			}),
		}),
		account,
	);
}

async function chatMetadata(request: Request): Promise<Metadata | undefined> {
	const body = new Uint8Array(await request.arrayBuffer());
	return fromBinary(GetChatMessageRequestSchema, gunzipSync(body.subarray(5)))
		.metadata;
}

/** The "chat" profile: GetUserJwt, GetUserStatus and GetChatMessage. */
const chatProfile = (os: string, userJwt?: string) => ({
	ideName: "devin-cli",
	ideVersion: "3000.11.1",
	ideType: "chisel",
	extensionName: "chisel",
	extensionVersion: "3000.11.1",
	apiKey: "devin-session-token$tok",
	locale: "en",
	os,
	...(userJwt ? { userJwt } : {}),
});

/** The "discovery" profile: GetCliModelConfigs only. */
const discoveryProfile = (os: string) => ({
	ideName: "chisel",
	ideVersion: "0.0.0-dev",
	ideType: "chisel",
	extensionName: "chisel",
	extensionVersion: "0.0.0-dev",
	apiKey: "devin-session-token$tok",
	locale: "en",
	os,
	supportedModelDisplays: [3, 4, 6, 7, 8],
});

const unaryHeaders: Pairs = [
	["accept", "application/proto"],
	["connect-protocol-version", "1"],
	["content-type", "application/proto"],
];

describe("Devin identity at the fetch boundary", () => {
	it("account RPCs send the Connect unary headers and nothing else", async () => {
		setPlatform("linux");
		const calls = await captureAccountLoad();
		expect([...calls.keys()].sort()).toEqual(
			[JWT_PATH, MODELS_PATH, STATUS_PATH].sort(),
		);
		for (const path of [JWT_PATH, MODELS_PATH, STATUS_PATH]) {
			expect(calls.get(path)?.url).toBe(`https://server.codeium.com${path}`);
			expect(calls.get(path)?.headers).toEqual(unaryHeaders);
		}
	});

	it("GetUserJwt body bytes", async () => {
		setPlatform("linux");
		const calls = await captureAccountLoad();
		expect(hex(calls.get(JWT_PATH)?.body ?? new Uint8Array())).toBe(
			"0a560a09646576696e2d636c693a09333030302e31312e31e2010663686973656c620663686973656c1209333030302e31312e311a17646576696e2d73657373696f6e2d746f6b656e24746f6b2202656e2a056c696e7578",
		);
	});

	it("GetCliModelConfigs body bytes", async () => {
		setPlatform("linux");
		const calls = await captureAccountLoad();
		expect(hex(calls.get(MODELS_PATH)?.body ?? new Uint8Array())).toBe(
			"0a5b0a0663686973656c3a09302e302e302d646576e2010663686973656c620663686973656c1209302e302e302d6465761a17646576696e2d73657373696f6e2d746f6b656e24746f6b2202656e2a056c696e7578f201050304060708",
		);
	});

	it("GetUserJwt and GetUserStatus carry the chat profile", async () => {
		setPlatform("linux");
		const calls = await captureAccountLoad();
		const jwt = fromBinary(
			GetUserJwtRequestSchema,
			calls.get(JWT_PATH)?.body ?? new Uint8Array(),
		);
		const status = fromBinary(
			GetUserStatusRequestSchema,
			calls.get(STATUS_PATH)?.body ?? new Uint8Array(),
		);
		expect(metadataJson(jwt.metadata)).toEqual(chatProfile("linux"));
		expect(metadataJson(status.metadata)).toEqual(chatProfile("linux"));
	});

	it("GetCliModelConfigs carries the discovery profile", async () => {
		setPlatform("linux");
		const calls = await captureAccountLoad();
		const models = fromBinary(
			GetCliModelConfigsRequestSchema,
			calls.get(MODELS_PATH)?.body ?? new Uint8Array(),
		);
		expect(metadataJson(models.metadata)).toEqual(discoveryProfile("linux"));
	});

	it("an already-prefixed session token is not prefixed twice", async () => {
		setPlatform("linux");
		const calls = await captureAccountLoad("devin-session-token$tok");
		const jwt = fromBinary(
			GetUserJwtRequestSchema,
			calls.get(JWT_PATH)?.body ?? new Uint8Array(),
		);
		expect(jwt.metadata?.apiKey).toBe("devin-session-token$tok");
	});

	it.each([
		["linux", "linux"],
		["darwin", "darwin"],
		["win32", "windows"],
		["freebsd", "linux"],
	])("platform %s is reported as os %s on every account RPC", async (platform, os) => {
		setPlatform(platform);
		const calls = await captureAccountLoad();
		const jwt = fromBinary(
			GetUserJwtRequestSchema,
			calls.get(JWT_PATH)?.body ?? new Uint8Array(),
		);
		const status = fromBinary(
			GetUserStatusRequestSchema,
			calls.get(STATUS_PATH)?.body ?? new Uint8Array(),
		);
		const models = fromBinary(
			GetCliModelConfigsRequestSchema,
			calls.get(MODELS_PATH)?.body ?? new Uint8Array(),
		);
		expect(metadataJson(jwt.metadata)).toEqual(chatProfile(os));
		expect(metadataJson(status.metadata)).toEqual(chatProfile(os));
		expect(metadataJson(models.metadata)).toEqual(discoveryProfile(os));
	});

	it("chat request headers drop every inbound client header", async () => {
		setPlatform("linux");
		const request = await captureChat();
		expect(request.url).toBe(
			"https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage",
		);
		expect(sortedHeaders(request.headers)).toEqual([
			["accept-encoding", "identity"],
			["connect-accept-encoding", "gzip"],
			["connect-content-encoding", "gzip"],
			["connect-protocol-version", "1"],
			["content-type", "application/connect+proto"],
			["x-clankermux-request-stream", "true"],
			["x-clankermux-upstream-model", "swe-2-high"],
		]);
	});

	it.each([
		["linux", "linux"],
		["darwin", "darwin"],
		["win32", "windows"],
	])("chat request on platform %s carries the chat profile with the user JWT", async (platform, os) => {
		setPlatform(platform);
		const request = await captureChat();
		expect(metadataJson(await chatMetadata(request))).toEqual(
			chatProfile(os, "user-jwt"),
		);
	});

	it("prepareHeaders replaces inbound client headers", () => {
		const provider = new DevinProvider(new StubClient());
		expect(
			sortedHeaders(provider.prepareHeaders(new Headers(inboundClientHeaders))),
		).toEqual([["content-type", "application/json"]]);
	});

	it("login code exchange headers", async () => {
		const login = createDevinLogin("manual");
		const captured: Array<{ url: string; headers: Pairs }> = [];
		await exchangeDevinLogin(login, "one-use-code", async (input, init) => {
			captured.push({
				url: String(input),
				headers: sortedHeaders(init?.headers),
			});
			return Response.json({ token: "session" });
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]).toEqual({
			url: "https://api.devin.ai/auth/cli/token",
			headers: [
				["accept", "application/json"],
				["content-type", "application/json"],
			],
		});
	});
});
