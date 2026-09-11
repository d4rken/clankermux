import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { APIContext } from "../../types";
import {
	createToolErrorExampleHandler,
	createToolErrorsHandler,
} from "../tool-errors-direct";

let dir: string;
let dbOps: DatabaseOperations;
const scope = { tool: "Bash", from: "100", to: "1000" };
const params = (extra: Record<string, string> = {}) =>
	new URLSearchParams({ ...scope, ...extra });
const context = () =>
	({ db: dbOps.getAdapter(), dbOps, config: {} }) as APIContext;
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "tool-evidence-"));
	dbOps = new DatabaseOperations(join(dir, "test.db"));
	const db = dbOps.getAdapter();
	for (const [id, time, project, session] of [
		["a", 200, "alpha", "s1"],
		["b", 300, null, null],
		["outside", 1100, "alpha", "s1"],
	] as const) {
		await db.run(
			`INSERT INTO requests (id,timestamp,method,path,status_code,success,project,session_key,model) VALUES (?,?,'POST','/v1/messages',200,1,?,?,'receiving-model')`,
			[id, time, project, session],
		);
		await db.run(`INSERT INTO request_tool_calls VALUES (?,'Bash',6,5)`, [id]);
		for (const text of ["failure", "failure", "different"])
			await db.run(
				`INSERT INTO request_tool_errors(request_id,tool_name,error_text) VALUES (?,'Bash',?)`,
				[id, text],
			);
	}
});
afterEach(async () => {
	await dbOps.dispose();
	rmSync(dir, { recursive: true, force: true });
});
it("keeps sampled counts separate, scopes details, and avoids join multiplication", async () => {
	const h = createToolErrorsHandler(context());
	const list = await (await h(params())).json();
	expect(list.totalErrors).toBe(10);
	expect(list.capturedTexts).toBe(6);
	expect(list.distinctGroups).toBe(2);
	expect(list.groups[0].errorText).toBe("failure");
	expect(list.groups[0].occurrences).toBe(4);
	const detail = await (
		await h(params({ sampleId: String(list.groups[0].sampleId) }))
	).json();
	expect(detail.detail.distinctRequests).toBe(2);
	expect(detail.detail.knownSessions).toBe(1);
	expect(detail.detail.requestsWithoutSession).toBe(1);
	expect(detail.detail.requests).toHaveLength(2);
	expect(detail.detail.projects).toEqual(
		expect.arrayContaining([
			{ project: "alpha", requests: 1 },
			{ project: null, requests: 1 },
		]),
	);
	expect(detail.detail.requests[0].payloadAvailable).toBe(false);
	const filtered = await (await h(params({ projectsNone: "true" }))).json();
	expect(filtered.totalErrors).toBe(5);
	expect(filtered.capturedTexts).toBe(3);
});
it("paginates deterministically and rejects invalid or expired selection tokens", async () => {
	const h = createToolErrorsHandler(context());
	const first = await (await h(params({ limit: "1" }))).json();
	const second = await (await h(params({ limit: "1", offset: "1" }))).json();
	expect(first.hasMore).toBe(true);
	expect(second.hasMore).toBe(false);
	expect(first.groups[0].errorText).not.toBe(second.groups[0].errorText);
	expect((await h(params({ sampleId: "999999" }))).status).toBe(404);
	expect((await h(params({ from: "NaN" }))).status).toBe(400);
	expect((await h(params({ to: "50" }))).status).toBe(400);
});
it("extracts only scoped matching final-message calls and never the envelope", async () => {
	const list = await (
		await createToolErrorsHandler(context())(params())
	).json();
	const sampleId = String(list.groups[0].sampleId);
	const body = {
		messages: [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "x",
						name: "Bash",
						input: { command: "echo failure" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "x",
						is_error: true,
						content: "failure",
					},
				],
			},
		],
	};
	await dbOps
		.getAdapter()
		.run("INSERT INTO request_payloads(id,json) VALUES (?,?)", [
			"a",
			JSON.stringify({
				request: {
					headers: { Authorization: "SECRET" },
					body: Buffer.from(JSON.stringify(body)).toString("base64"),
				},
			}),
		]);
	const h = createToolErrorExampleHandler(context());
	const result = await (await h(params({ sampleId, requestId: "a" }))).json();
	expect(result.state).toBe("matched");
	expect(result.matches[0].input).toContain("echo failure");
	expect(JSON.stringify(result)).not.toContain("SECRET");
	expect((await h(params({ sampleId, requestId: "outside" }))).status).toBe(
		404,
	);
	const missing = await (await h(params({ sampleId, requestId: "b" }))).json();
	expect(missing.state).toBe("unavailable");
});
it("enforces every filter on group selection and example membership", async () => {
	const db = dbOps.getAdapter();
	await db.run(
		"UPDATE requests SET account_used='account-a',api_key_id='key-a',model='model-a',success=0,status_code=500 WHERE id='a'",
	);
	const h = createToolErrorsHandler(context());
	for (const filter of [
		{ accounts: "account-a" },
		{ apiKeys: "key-a" },
		{ models: "model-a" },
		{ projects: "alpha" },
		{ status: "error" },
	]) {
		const list = await (await h(params(filter))).json();
		expect(list.totalErrors).toBe(5);
		expect(list.capturedTexts).toBe(3);
		const d = await (
			await h(params({ ...filter, sampleId: String(list.groups[0].sampleId) }))
		).json();
		expect(d.detail.distinctRequests).toBe(1);
		expect(
			(
				await createToolErrorExampleHandler(context())(
					params({
						...filter,
						sampleId: String(list.groups[0].sampleId),
						requestId: "b",
					}),
				)
			).status,
		).toBe(404);
	}
	const nullAccount = await (await h(params({ accountsNone: "true" }))).json();
	expect(nullAccount.totalErrors).toBe(5);
	const a = await (await h(params({ projects: "alpha" }))).json();
	expect(
		(
			await h(
				params({
					projectsNone: "true",
					sampleId: String(a.groups[0].sampleId),
				}),
			)
		).status,
	).toBe(404);
});
it("handles malformed and disappearing payloads without claiming a successful match", async () => {
	const h = createToolErrorsHandler(context());
	const list = await (await h(params())).json();
	const sampleId = String(list.groups[0].sampleId);
	await dbOps
		.getAdapter()
		.run("INSERT INTO request_payloads(id,json) VALUES (?,?)", [
			"a",
			JSON.stringify({
				request: { body: Buffer.from('{"messages":[').toString("base64") },
			}),
		]);
	const example = createToolErrorExampleHandler(context());
	expect(
		(await (await example(params({ sampleId, requestId: "a" }))).json()).state,
	).toBe("malformed");
	await dbOps
		.getAdapter()
		.run("DELETE FROM request_payloads WHERE id=?", ["a"]);
	expect(
		(await (await example(params({ sampleId, requestId: "a" }))).json()).state,
	).toBe("unavailable");
	await dbOps
		.getAdapter()
		.run("DELETE FROM request_tool_errors WHERE id=?", [Number(sampleId)]);
	expect((await h(params({ sampleId }))).status).toBe(404);
});
it("serves details through the actual background worker and keeps cache scopes separate", async () => {
	const {
		createIsolatedToolErrorsHandler,
		clearAnalyticsCachesForTests,
		terminateAnalyticsWorker,
	} = await import("../analytics-runner");
	clearAnalyticsCachesForTests();
	try {
		const h = createIsolatedToolErrorsHandler(context());
		const response = await h(params());
		expect(response.status).toBe(200);
		expect(response.headers.get("x-clankermux-analytics-mode")).toBe("worker");
		const first = await response.json();
		expect(first.totalErrors).toBe(10);
		const filtered = await (await h(params({ projects: "alpha" }))).json();
		expect(filtered.totalErrors).toBe(5);
		const selected = await (
			await h(params({ sampleId: String(first.groups[0].sampleId) }))
		).json();
		expect(selected.detail.distinctRequests).toBe(2);
	} finally {
		terminateAnalyticsWorker();
		clearAnalyticsCachesForTests();
	}
});
it("matches stored samples when the UTF16 capture boundary splits an emoji", async () => {
	const { extractToolErrorText } = await import("@clankermux/core");
	const text = `${"a".repeat(499)}😀tail`;
	await dbOps
		.getAdapter()
		.run("DELETE FROM request_tool_errors WHERE request_id=?", ["a"]);
	await dbOps
		.getAdapter()
		.run(
			"INSERT INTO request_tool_errors(request_id,tool_name,error_text) VALUES ('a','Bash',?)",
			[extractToolErrorText(text)],
		);
	const body = {
		messages: [
			{
				content: [
					{
						type: "tool_use",
						id: "x",
						name: "Bash",
						input: { command: "unicode" },
					},
				],
			},
			{
				content: [
					{
						type: "tool_result",
						tool_use_id: "x",
						is_error: true,
						content: text,
					},
				],
			},
		],
	};
	await dbOps
		.getAdapter()
		.run("INSERT INTO request_payloads(id,json) VALUES (?,?)", [
			"a",
			JSON.stringify({
				request: { body: Buffer.from(JSON.stringify(body)).toString("base64") },
			}),
		]);
	const list = await (
		await createToolErrorsHandler(context())(params({ projects: "alpha" }))
	).json();
	const evidence = await (
		await createToolErrorExampleHandler(context())(
			params({ sampleId: String(list.groups[0].sampleId), requestId: "a" }),
		)
	).json();
	expect(evidence.state).toBe("matched");
	expect(evidence.matches[0].result).toBe(text);
});
it("keeps a split-surrogate sample distinct from literal replacement characters", async () => {
	const { extractToolErrorText, toolErrorStorageHex } = await import(
		"@clankermux/core"
	);
	const texts = [`${"a".repeat(499)}😀tail`, `${"a".repeat(499)}�`];
	await dbOps
		.getAdapter()
		.run("DELETE FROM request_tool_errors WHERE request_id IN ('a','b')");
	for (const [index, id] of ["a", "b"].entries()) {
		const text = texts[index] ?? "";
		const sample = extractToolErrorText(text);
		await dbOps
			.getAdapter()
			.run(
				"INSERT INTO request_tool_errors(request_id,tool_name,error_text) VALUES (?,'Bash',?)",
				[id, sample],
			);
		const stored = await dbOps
			.getAdapter()
			.query<{ hex: string }>(
				"SELECT hex(error_text) hex FROM request_tool_errors WHERE request_id=?",
				[id],
			);
		expect(stored[0]?.hex).toBe(toolErrorStorageHex(sample));
		const body = {
			messages: [
				{
					content: [
						{ type: "tool_use", id: "x", name: "Bash", input: { command: id } },
					],
				},
				{
					content: [
						{
							type: "tool_result",
							tool_use_id: "x",
							is_error: true,
							content: text,
						},
					],
				},
			],
		};
		await dbOps
			.getAdapter()
			.run("INSERT INTO request_payloads(id,json) VALUES (?,?)", [
				id,
				JSON.stringify({
					request: {
						body: Buffer.from(JSON.stringify(body)).toString("base64"),
					},
				}),
			]);
	}
	const h = createToolErrorsHandler(context());
	const list = await (await h(params())).json();
	expect(list.distinctGroups).toBe(2);
	for (const group of list.groups) {
		const detail = await (
			await h(params({ sampleId: String(group.sampleId) }))
		).json();
		expect(detail.detail.distinctRequests).toBe(1);
		const requestId = detail.detail.requests[0].requestId;
		const result = await (
			await createToolErrorExampleHandler(context())(
				params({ sampleId: String(group.sampleId), requestId }),
			)
		).json();
		expect(result.state).toBe("matched");
		expect(result.matches[0].input).toContain(requestId);
	}
});
