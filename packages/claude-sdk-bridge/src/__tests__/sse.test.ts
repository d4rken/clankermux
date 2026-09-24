import { describe, expect, it } from "bun:test";
import { bridgeErrors } from "../errors";
import { LegResponse } from "../sse";
import { parseSse } from "./fixtures/fake-sdk";

function leg(opts: Partial<ConstructorParameters<typeof LegResponse>[0]> = {}) {
	const gone: string[] = [];
	const response = new LegResponse({
		stream: true,
		headHoldMs: 100,
		pingIntervalMs: 60,
		signal: new AbortController().signal,
		onClientGone: () => gone.push("gone"),
		...opts,
	});
	return { response, gone };
}

const start = {
	type: "message_start",
	message: {
		id: "m",
		type: "message",
		role: "assistant",
		content: [],
		usage: {},
	},
};

describe("LegResponse", () => {
	it("holds the head so an error before any output gets its real status as JSON", async () => {
		const { response } = leg();
		response.fail(bridgeErrors.processCap(4));
		const res = await response.response;
		expect(res.status).toBe(529);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("retry-after")).toBe("10");
	});

	it("commits the head on the first event", async () => {
		const { response } = leg({ headHoldMs: 10_000 });
		response.send(start);
		const res = await response.response;
		expect(res.status).toBe(200);
		response.end();
		expect(parseSse(await res.text()).map((e) => e.event)).toEqual([
			"message_start",
		]);
	});

	it("commits after the hold with a ping, then reports errors as an SSE error event", async () => {
		const { response } = leg({ headHoldMs: 30 });
		const res = await response.response;
		expect(res.status).toBe(200);
		expect(response.committed).toBe(true);
		response.fail(bridgeErrors.deadline(1000));
		const events = parseSse(await res.text());
		expect(events[0]?.event).toBe("ping");
		expect(events.at(-1)).toEqual({
			event: "error",
			data: {
				type: "error",
				error: {
					type: "timeout_error",
					message: "The SDK bridge turn exceeded its 1 s deadline",
				},
			},
		});
	});

	it("pings during silence", async () => {
		const { response } = leg({ pingIntervalMs: 50 });
		response.send(start);
		const res = await response.response;
		await Bun.sleep(180);
		response.end();
		const events = parseSse(await res.text());
		expect(
			events.filter((e) => e.event === "ping").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("reduces the reply to one Message for stream:false", async () => {
		const { response } = leg({ stream: false });
		response.send(start);
		response.send({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		response.send({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "hi" },
		});
		response.send({ type: "content_block_stop", index: 0 });
		response.send({
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "t1", name: "read", input: {} },
		});
		response.send({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"path":' },
		});
		response.send({
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '"a"}' },
		});
		response.send({
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 7 },
		});
		response.send({ type: "message_stop" });
		response.end();
		const res = await response.response;
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({
			id: "m",
			type: "message",
			role: "assistant",
			content: [
				{ type: "text", text: "hi" },
				{ type: "tool_use", id: "t1", name: "read", input: { path: "a" } },
			],
			stop_reason: "tool_use",
			stop_sequence: null,
			usage: { output_tokens: 7 },
		});
	});

	it("reports a client that goes away", async () => {
		const controller = new AbortController();
		const { response, gone } = leg({ signal: controller.signal });
		response.send(start);
		controller.abort();
		expect(gone).toEqual(["gone"]);
		expect(response.done).toBe(true);
	});
});
