/**
 * A `[1m]` catalogue id at the public front door. Accounts list only the
 * bare id. Claude Code is a scripted stand-in whose model call goes through
 * the bridge's inner listener and the real proxy to a loopback mock upstream.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockUpstream } from "../../../../packages/claude-sdk-bridge/src/__tests__/fixtures/mock-upstream";
import { callModel, fakeQueryFn, relay } from "./fixtures/scripted-claude-code";
import { type Gateway, startGateway } from "./fixtures/sdk-bridge-gateway";

const BARE = "claude-opus-5-5";
const ONE_M = `${BARE}[1m]`;

const mock = startMockUpstream();
afterAll(() => mock.stop());

let current: { gw: Gateway; root: string } | null = null;
afterEach(async () => {
	if (!current) return;
	const { gw, root } = current;
	current = null;
	await gw.stop();
	expect(gw.blockedEgress.filter((h) => /anthropic|claude/i.test(h))).toEqual(
		[],
	);
	rmSync(root, { recursive: true, force: true });
});

async function harness() {
	const sdk = fakeQueryFn();
	const root = mkdtempSync(join(tmpdir(), "cmx-bridge-1m-"));
	const n = crypto.randomUUID().slice(0, 8);
	const gw = await startGateway({
		root,
		upstreamUrl: mock.url,
		accounts: [
			{ id: `acct-${n}`, name: `claude-${n}`, token: `sk-ant-oat01-${n}` },
		],
		models: [BARE],
		bridge: {
			queryFn: sdk.fn,
			claudeExecutablePath: "/opt/fake/claude",
			timing: {
				headHoldMs: 2_000,
				pingIntervalMs: 500,
				settleWaitMs: 500,
				idleTimeoutMs: 20_000,
				exitGraceMs: 50,
			},
		},
	});
	current = { gw, root };
	return { gw, sdk };
}

function post(gw: Gateway, path: string, body: Record<string, unknown>) {
	return fetch(`${gw.url}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${gw.apiKey}`,
			"content-type": "application/json",
			"user-agent": "pi/0.86.0",
			"x-clankermux-pi-prompt": "0.87",
			session_id: `one-m-${crypto.randomUUID()}`,
		},
		body: JSON.stringify(body),
	});
}

/** A Claude Code request on the direct Anthropic mount. */
function claudeCode(gw: Gateway, model: string) {
	return fetch(`${gw.url}/wire/anthropic/v1/messages?beta=true`, {
		method: "POST",
		headers: {
			"x-api-key": gw.apiKey,
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			"user-agent": "claude-cli/2.1.280 (external, cli)",
		},
		body: JSON.stringify({
			model,
			max_tokens: 64,
			stream: true,
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

function upstreamModels(since: number): unknown[] {
	return mock.requests
		.slice(since)
		.filter((r) => r.path.startsWith("/v1/messages"))
		.map((r) => (r.body as { model?: unknown }).model);
}

for (const endpoint of ["responses", "chat"] as const)
	describe(`a [1m] id at /wire/openai ${endpoint}`, () => {
		it("routes to an account listing the bare id, and Claude Code gets the suffix", async () => {
			const { gw, sdk } = await harness();
			const since = mock.requests.length;
			const pending =
				endpoint === "chat"
					? post(gw, "/wire/openai/v1/chat/completions", {
							model: ONE_M,
							stream: true,
							messages: [{ role: "user", content: "hello" }],
						})
					: post(gw, "/wire/openai/v1/responses", {
							model: ONE_M,
							stream: true,
							input: "hello",
						});
			const query = await sdk.next();
			expect(query.options.model).toBe(ONE_M);
			await query.nextPrompt();
			// Claude Code resolves the suffix into its beta header and sends the
			// bare id.
			await relay(query, await callModel(query, { model: BARE }));
			const response = await pending;
			expect(response.status).toBe(200);
			await response.text();
			expect(upstreamModels(since)).toEqual([BARE]);
		});
	});

describe("a [1m] id on a direct attempt", () => {
	it("is refused with a named 400 before any upstream fetch", async () => {
		const { gw, sdk } = await harness();
		const since = mock.requests.length;
		const response = await claudeCode(gw, ONE_M);
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { type: string; message: string };
		};
		expect(body.error.type).toBe("model_suffix_requires_claude_code");
		expect(body.error.message).toContain(ONE_M);
		expect(upstreamModels(since)).toEqual([]);
		expect(sdk.queries).toEqual([]);
	});

	it("leaves a Claude Code request for the bare id alone", async () => {
		const { gw } = await harness();
		const since = mock.requests.length;
		const response = await claudeCode(gw, BARE);
		expect(response.status).toBe(200);
		await response.text();
		expect(upstreamModels(since)).toEqual([BARE]);
	});
});
