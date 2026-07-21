import { describe, expect, it } from "bun:test";
import { decodeJwtPayloadSafe } from "./jwt";

function b64url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function makeJwt(payload: unknown): string {
	const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
	const body = b64url(JSON.stringify(payload));
	return `${header}.${body}.sig`;
}

describe("decodeJwtPayloadSafe", () => {
	it("decodes the payload of a well-formed JWT", () => {
		const token = makeJwt({ sub: "abc", email: "user@example.com", n: 7 });
		expect(decodeJwtPayloadSafe(token)).toEqual({
			sub: "abc",
			email: "user@example.com",
			n: 7,
		});
	});

	it("returns null for a token with no payload segment", () => {
		expect(decodeJwtPayloadSafe("onlyonesegment")).toBeNull();
	});

	it("returns null when the payload is not valid base64url/JSON", () => {
		// "%%%" is not valid base64url and won't decode to parseable JSON.
		expect(decodeJwtPayloadSafe("header.%%%.sig")).toBeNull();
	});

	it("returns null when the payload base64 decodes to malformed JSON", () => {
		const token = `header.${b64url("{not-json")}.sig`;
		expect(decodeJwtPayloadSafe(token)).toBeNull();
	});

	it("returns null when the payload JSON is not an object", () => {
		const token = `header.${b64url("42")}.sig`;
		expect(decodeJwtPayloadSafe(token)).toBeNull();
	});

	it("returns null when the payload JSON is an array", () => {
		const token = `header.${b64url("[1,2,3]")}.sig`;
		expect(decodeJwtPayloadSafe(token)).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(decodeJwtPayloadSafe("")).toBeNull();
	});
});
