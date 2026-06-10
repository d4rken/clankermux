import { describe, expect, test } from "bun:test";
import { handleModelsRequest } from "../models";

describe("handleModelsRequest", () => {
	test("returns 200 JSON in the OpenAI Models-list shape", async () => {
		const resp = handleModelsRequest();
		expect(resp.status).toBe(200);
		expect(resp.headers.get("Content-Type")).toBe("application/json");

		const body = (await resp.json()) as {
			object: string;
			data: Array<{
				id: string;
				object: string;
				created: number;
				owned_by: string;
			}>;
		};
		expect(body.object).toBe("list");
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data.length).toBeGreaterThan(0);
		for (const m of body.data) {
			expect(typeof m.id).toBe("string");
			expect(m.id.length).toBeGreaterThan(0);
			expect(m.object).toBe("model");
			expect(typeof m.created).toBe("number");
			expect(typeof m.owned_by).toBe("string");
		}
	});

	test("includes the gpt-5.x models a Codex user would configure", async () => {
		const body = (await handleModelsRequest().json()) as {
			data: Array<{ id: string }>;
		};
		const ids = body.data.map((m) => m.id);
		expect(ids).toContain("gpt-5.5");
		expect(ids).toContain("gpt-5.4");
		expect(ids).toContain("gpt-5.4-mini");
		expect(ids).toContain("gpt-5.3-codex-spark");
	});

	test("model ids are unique", async () => {
		const body = (await handleModelsRequest().json()) as {
			data: Array<{ id: string }>;
		};
		const ids = body.data.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
