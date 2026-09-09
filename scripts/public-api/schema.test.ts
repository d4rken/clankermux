import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { toDraft2020, writeOrCheckSchemas } from "./generate";
import {
	compatibilityFields,
	type PublicResource,
	resources,
} from "./manifest";
import {
	assertPublicSchema,
	exampleDirectory,
	validateExamples,
} from "./validate";

async function example(name: string) {
	return JSON.parse(
		await readFile(new URL(`${name}.json`, exampleDirectory), "utf8"),
	);
}

function removeAt(value: unknown, path: string[]): void {
	if (value === null || typeof value !== "object") return;
	const [key, ...rest] = path;
	if (key === "[]") {
		if (Array.isArray(value)) for (const item of value) removeAt(item, rest);
		return;
	}
	if (!key) return;
	const object = value as Record<string, unknown>;
	if (rest.length) removeAt(object[key], rest);
	else delete object[key];
}

describe("public API schemas", () => {
	it("reproduces all seven committed artifacts from the public DTO types", async () => {
		await writeOrCheckSchemas(true);
	}, 30_000);

	it("validates all complete examples, including workload edge cases and stream variants", async () => {
		expect(await validateExamples()).toBeGreaterThanOrEqual(20);
	});

	it("accepts pre-change v1 payloads, with nextReset both present and absent", async () => {
		for (const resource of ["runway", "workload-headroom"] as const) {
			const legacy = await example(resource);
			for (const path of compatibilityFields[resource] ?? []) {
				if (path === "rows.[].nextReset") continue;
				removeAt(legacy, path.split("."));
			}
			expect(() => assertPublicSchema(resource, legacy)).not.toThrow();
			if (resource === "workload-headroom") {
				delete legacy.rows[0].nextReset;
				expect(() => assertPublicSchema(resource, legacy)).not.toThrow();
			}
		}
	});

	it("accepts additive fields at every object depth", async () => {
		const payload = await example("workload-headroom");
		payload.futureEnvelopeField = true;
		payload.rows[0].futureRowField = { futureNestedField: 1 };
		payload.rows[0].nextReset.futureIntervalField = "new";
		expect(() =>
			assertPublicSchema("workload-headroom", payload),
		).not.toThrow();
		const accounts = await example("accounts");
		accounts.accounts[0].windows[0].prediction.futurePredictionField = true;
		expect(() => assertPublicSchema("accounts", accounts)).not.toThrow();
	});

	it("pins each resource schema identifier and known descriptive enums", async () => {
		for (const resource of Object.keys(resources) as PublicResource[]) {
			const payload = await example(
				resource === "stream" ? "stream.snapshot" : resource,
			);
			payload.schema = "clankermux.public.unknown.v1";
			expect(() => assertPublicSchema(resource, payload)).toThrow();
		}
		const workload = await example("workload-headroom");
		workload.rows[0].guidanceState = "other";
		expect(() =>
			assertPublicSchema("workload-headroom", workload),
		).not.toThrow();
		workload.rows[0].guidanceState = "future_internal_state";
		expect(() => assertPublicSchema("workload-headroom", workload)).toThrow();
	});

	it("rejects non-ISO instants, negative or fractional counts, and invalid durations", async () => {
		const runway = await example("runway");
		for (const invalid of [-1, 0.5, null]) {
			runway.coverage.activeKeyCount = invalid;
			expect(() => assertPublicSchema("runway", runway)).toThrow();
		}
		runway.coverage.activeKeyCount = 2;
		runway.generatedAt = "tomorrow";
		expect(() => assertPublicSchema("runway", runway)).toThrow();
		runway.generatedAt = "2026-09-09T12:00:00.000Z";
		runway.horizonMs = -1;
		expect(() => assertPublicSchema("runway", runway)).toThrow();
		const done = await example("stream.done");
		done.totalTokens = null;
		expect(() => assertPublicSchema("stream", done)).not.toThrow();
		done.totalTokens = 0.5;
		expect(() => assertPublicSchema("stream", done)).toThrow();
	});

	it("requires legacy fields and distinguishes a missing nullable field from null", async () => {
		const accounts = await example("accounts");
		accounts.accounts[0].credential.expiresAt = null;
		expect(() => assertPublicSchema("accounts", accounts)).not.toThrow();
		delete accounts.accounts[0].credential.expiresAt;
		expect(() => assertPublicSchema("accounts", accounts)).toThrow();
	});
});

describe("Draft 7 to 2020-12 conversion", () => {
	it("preserves reference, tuple and dependency validation semantics", () => {
		const source = {
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			definitions: { identifier: { type: "string" } },
			properties: {
				id: { $ref: "#/definitions/identifier" },
				name: { type: "string" },
				pair: {
					type: "array",
					items: [{ type: "string" }, { type: "number" }],
					additionalItems: false,
				},
			},
			dependencies: {
				id: ["name"],
				pair: { properties: { id: { const: "known" } }, required: ["id"] },
			},
		};
		const converted = toDraft2020(source) as Record<string, unknown>;
		expect(converted).toHaveProperty("$defs");
		expect(converted).not.toHaveProperty("definitions");
		expect(converted).toHaveProperty("dependentRequired");
		expect(converted).toHaveProperty("dependentSchemas");
		const oldValidator = new Ajv({ strict: false }).compile(source);
		const newValidator = new Ajv2020({ strict: false }).compile(converted);
		const samples = [
			{},
			{ id: "known", name: "sample", pair: ["x", 2] },
			{ id: "known" },
			{ id: "known", name: "sample", pair: ["x", 2, 3] },
			{ id: "wrong", name: "sample", pair: ["x", 2] },
			{ id: "known", name: "sample", pair: [1, "x"] },
		];
		for (const sample of samples)
			expect(newValidator(sample)).toBe(oldValidator(sample));
	});
});
