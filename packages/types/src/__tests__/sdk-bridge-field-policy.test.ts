import { describe, expect, it } from "bun:test";
import {
	SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES,
	sdkBridgeRefusedField,
} from "../sdk-bridge-field-policy";

/** A schema whose JSON is `bytes` UTF-8 bytes, padded with `pad`. */
function schemaOfBytes(bytes: number, pad = "x") {
	const empty = JSON.stringify({ description: "" }).length;
	const padBytes = new TextEncoder().encode(pad).length;
	const count = Math.floor((bytes - empty) / padBytes);
	const rest = bytes - empty - count * padBytes;
	const schema = { description: pad.repeat(count) + "x".repeat(rest) };
	expect(new TextEncoder().encode(JSON.stringify(schema)).length).toBe(bytes);
	return schema;
}

const withSchema = (schema: unknown) => ({
	output_config: { format: { type: "json_schema", schema } },
});

describe("the output schema's size", () => {
	it("takes a schema of exactly the limit and refuses one byte more", () => {
		expect(
			sdkBridgeRefusedField(
				withSchema(schemaOfBytes(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES)),
			),
		).toBeNull();
		const refused = sdkBridgeRefusedField(
			withSchema(schemaOfBytes(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES + 1)),
		);
		expect(refused?.field).toBe("output_config.format");
		expect(refused?.message).toContain(
			String(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES),
		);
	});

	it("counts UTF-8 bytes, not string length", () => {
		const schema = schemaOfBytes(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES + 1, "é");
		expect(JSON.stringify(schema).length).toBeLessThan(
			SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES,
		);
		expect(sdkBridgeRefusedField(withSchema(schema))?.field).toBe(
			"output_config.format",
		);
		expect(
			sdkBridgeRefusedField(
				withSchema(schemaOfBytes(SDK_BRIDGE_MAX_OUTPUT_SCHEMA_BYTES, "é")),
			),
		).toBeNull();
	});
});
