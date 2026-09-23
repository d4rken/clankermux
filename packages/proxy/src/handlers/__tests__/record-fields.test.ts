import { describe, expect, it } from "bun:test";
import type { RequestMeta } from "@clankermux/types";
import { recordFieldsFromMeta } from "../record-fields";

type Composition = NonNullable<RequestMeta["contextComposition"]>;
type ToolStats = NonNullable<RequestMeta["toolCallStats"]>;
type PrefixHashes = NonNullable<RequestMeta["cachePrefixHashes"]>;
type Routing = NonNullable<RequestMeta["routing"]>;

describe("recordFieldsFromMeta", () => {
	it("copies every recorded field from a fully populated requestMeta", () => {
		const contextComposition = {
			marker: "composition",
		} as unknown as Composition;
		const toolCallStats = [{ marker: "tools" }] as unknown as ToolStats;
		const cachePrefixHashes = { marker: "hashes" } as unknown as PrefixHashes;
		const routing: Routing = {
			strategy: "session",
			decision: "affinity_hit",
			selectedAccountId: "acc-1",
		};
		const requestMeta: RequestMeta = {
			id: "req-1",
			method: "POST",
			path: "/v1/messages",
			timestamp: 1_700_000_000_000,
			internal: true,
			requestedModel: "claude-opus-5-5",
			fallbackCreditClaimed: true,
			fallbackFromModel: "claude-fable-5-1",
			project: "clankermux",
			projectAttributionSource: "repo_root",
			contextComposition,
			toolCallStats,
			reasoningEffort: "high",
			sessionKey: "session-1",
			cachePrefixHashes,
			clientUserAgent: "claude-cli/2.1.240",
			clientHarness: "claude-code",
			claudeDeviceId:
				"e01c000000000000000000000000000000000000000000000000000000000000",
			comboName: "combo-a",
			routing,
			// Fields that are not per-request record data stay out of the result.
			affinityKey: "affinity",
			headers: new Headers({ "x-test": "1" }),
		};

		const fields = recordFieldsFromMeta(requestMeta);

		expect(fields).toEqual({
			requestId: "req-1",
			timestamp: 1_700_000_000_000,
			internal: true,
			requestedModel: "claude-opus-5-5",
			fallbackCreditClaimed: true,
			fallbackFromModel: "claude-fable-5-1",
			project: "clankermux",
			projectAttributionSource: "repo_root",
			contextComposition,
			toolCallStats,
			reasoningEffort: "high",
			sessionKey: "session-1",
			cachePrefixHashes,
			clientUserAgent: "claude-cli/2.1.240",
			clientHarness: "claude-code",
			claudeDeviceId:
				"e01c000000000000000000000000000000000000000000000000000000000000",
			comboName: "combo-a",
			routing,
		});
		expect(fields.contextComposition).toBe(contextComposition);
		expect(fields.toolCallStats).toBe(toolCallStats);
		expect(fields.cachePrefixHashes).toBe(cachePrefixHashes);
		expect(fields.routing).toBe(routing);
	});

	it("passes absent fields through unchanged, except internal and routing", () => {
		const fields = recordFieldsFromMeta({
			id: "req-2",
			method: "POST",
			path: "/v1/messages",
			timestamp: 42,
		});

		expect(fields.internal).toBe(false);
		expect(fields.routing).toBeNull();
		expect(fields.requestedModel).toBeUndefined();
		expect(fields.project).toBeUndefined();
		expect(fields.clientHarness).toBeUndefined();
		expect(fields.claudeDeviceId).toBeUndefined();
	});
});
