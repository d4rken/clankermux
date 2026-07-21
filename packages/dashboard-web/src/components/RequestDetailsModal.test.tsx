import { describe, expect, it } from "bun:test";
import type { RequestPayload } from "../api";
import { shouldHydrateRequestPayload } from "./RequestDetailsModal";

function placeholder(overrides: Partial<RequestPayload> = {}): RequestPayload {
	return {
		id: "req-error",
		request: { headers: {}, body: null },
		response: { status: 529, headers: {}, body: null },
		error: "provider_overloaded",
		meta: {
			timestamp: 1_700_000_000_000,
			success: false,
			bodiesOmitted: true,
		},
		...overrides,
	};
}

describe("shouldHydrateRequestPayload", () => {
	it("hydrates historical error summaries instead of treating execution errors as load failures", () => {
		expect(shouldHydrateRequestPayload(placeholder(), true, null, null)).toBe(
			true,
		);
	});

	it("waits for pending requests to finish", () => {
		expect(
			shouldHydrateRequestPayload(
				placeholder({
					meta: { timestamp: 1, pending: true, bodiesOmitted: true },
				}),
				true,
				null,
				null,
			),
		).toBe(false);
	});

	it("does not refetch a hydrated or known-missing payload", () => {
		const request = placeholder();
		expect(shouldHydrateRequestPayload(request, true, request.id, null)).toBe(
			false,
		);
		expect(shouldHydrateRequestPayload(request, true, null, request.id)).toBe(
			false,
		);
	});
});
