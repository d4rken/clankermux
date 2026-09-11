import { describe, expect, it } from "bun:test";
import {
	GetChatMessageResponseSchema,
	GetUserJwtRequestSchema,
	MetadataSchema,
} from "../vendor/devin-proto";
import { create, fromBinary, toBinary } from "../vendor/protobuf";

describe("Devin protobuf wire contract", () => {
	it("encodes auth Metadata.api_key at field 3 nested in request field 1", () => {
		const request = create(GetUserJwtRequestSchema, {
			metadata: create(MetadataSchema, { apiKey: "key" }),
		});
		expect([...toBinary(GetUserJwtRequestSchema, request)]).toEqual([
			10, 5, 26, 3, 107, 101, 121,
		]);
	});
	it("decodes text and stop reason from independently specified wire bytes", () => {
		const decoded = fromBinary(
			GetChatMessageResponseSchema,
			new Uint8Array([26, 2, 104, 105, 40, 1]),
		);
		expect(decoded.deltaText).toBe("hi");
		expect(decoded.stopReason).toBe(1);
	});
});
