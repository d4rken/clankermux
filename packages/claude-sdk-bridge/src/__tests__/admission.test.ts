import { describe, expect, it } from "bun:test";
import { checkAdmission, checkBodySize } from "../admission";
import {
	parseTurnBody,
	parseTurnRequest,
	type TurnRequest,
} from "../turn-request";
import { DEFAULT_SDK_BRIDGE_LIMITS } from "../types";
import { makePlan } from "./fixtures/fake-sdk";

function turn(extra: Record<string, unknown> = {}, bytes = 100): TurnRequest {
	const parsed = parseTurnRequest(
		{
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			...extra,
		},
		null,
		bytes,
	);
	if (!parsed.ok) throw new Error(parsed.error.message);
	return parsed.turn;
}

const input = (
	overrides: Partial<Parameters<typeof checkAdmission>[0]> = {},
) => ({
	turn: turn(),
	plan: makePlan(),
	limits: DEFAULT_SDK_BRIDGE_LIMITS,
	processes: 0,
	rebuilds: 0,
	needsRebuild: false,
	...overrides,
});

describe("admission", () => {
	it("admits an ordinary turn", () => {
		expect(checkAdmission(input())).toBeNull();
	});

	it("answers 529 with Retry-After at the process cap, parked processes included", () => {
		const rejection = checkAdmission(
			input({ processes: DEFAULT_SDK_BRIDGE_LIMITS.maxProcesses }),
		);
		expect(rejection).toMatchObject({
			status: 529,
			reason: "process_cap",
			retryAfter: "10",
		});
	});

	it("answers 503 for a plan with no candidates", () => {
		const rejection = checkAdmission(
			input({ plan: makePlan({ candidates: [] }) }),
		);
		expect(rejection).toMatchObject({
			status: 503,
			reason: "no_eligible_account",
		});
	});

	it("names the limit a runaway request exceeds", () => {
		const limits = {
			...DEFAULT_SDK_BRIDGE_LIMITS,
			maxTools: 1,
			maxSchemaBytes: 10,
			maxHistoryBytes: 50,
		};
		const tools = [
			{ name: "a", input_schema: { type: "object" } },
			{ name: "b", input_schema: { type: "object" } },
		];
		expect(
			checkAdmission(input({ limits, turn: turn({ tools }, 10) })),
		).toMatchObject({
			status: 400,
			message: "SDK bridge limit maxTools exceeded: 2 > 1",
		});
		expect(
			checkAdmission(
				input({
					limits: { ...limits, maxTools: 10 },
					turn: turn(
						{
							tools: [
								{
									name: "a",
									input_schema: { type: "object", properties: { x: {} } },
								},
							],
						},
						10,
					),
				}),
			),
		).toMatchObject({ status: 413, type: "request_too_large" });
		expect(checkBodySize(51, limits)).toMatchObject({ status: 413 });
		expect(checkBodySize(50, limits)).toBeNull();
		expect(
			checkAdmission(
				input({
					limits: { ...DEFAULT_SDK_BRIDGE_LIMITS, maxConcurrentRebuilds: 1 },
					needsRebuild: true,
					rebuilds: 1,
				}),
			),
		).toMatchObject({ status: 529, reason: "rebuild_cap" });
	});

	it("counts an output format's schema under maxSchemaBytes, with the tools'", () => {
		const schema = { type: "object", properties: { x: {} } };
		const bytes = JSON.stringify(schema).length;
		const output_config = { format: { type: "json_schema", schema } };
		const tools = [{ name: "a", input_schema: { type: "object" } }];
		const at = (maxSchemaBytes: number, extra: Record<string, unknown>) =>
			checkAdmission(
				input({
					limits: { ...DEFAULT_SDK_BRIDGE_LIMITS, maxSchemaBytes },
					turn: turn({ output_config, ...extra }),
				}),
			);
		expect(at(bytes, {})).toBeNull();
		expect(at(bytes - 1, {})).toMatchObject({
			status: 413,
			type: "request_too_large",
			message: `SDK bridge limit maxSchemaBytes exceeded: ${bytes} > ${bytes - 1}`,
		});
		// A format never shares a turn with tools, but the count is one sum.
		const both = parseTurnBody(
			{
				model: "claude-sonnet-5",
				messages: [{ role: "user", content: "hi" }],
				tools,
			},
			null,
			1,
		);
		if (!both.ok) throw new Error(both.error.message);
		expect(both.body.schemaBytes).toBe(
			JSON.stringify(tools[0]?.input_schema).length,
		);
	});

	it("keeps the defaults far above real sessions", () => {
		expect(DEFAULT_SDK_BRIDGE_LIMITS.maxHistoryBytes).toBe(64 * 1024 * 1024);
		expect(DEFAULT_SDK_BRIDGE_LIMITS.maxTools).toBe(1024);
		expect(DEFAULT_SDK_BRIDGE_LIMITS.maxSchemaBytes).toBe(8 * 1024 * 1024);
		expect(DEFAULT_SDK_BRIDGE_LIMITS.maxParkedCallsPerTurn).toBe(256);
		expect(DEFAULT_SDK_BRIDGE_LIMITS.maxConcurrentRebuilds).toBe(8);
	});
});
