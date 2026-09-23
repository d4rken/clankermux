/**
 * Polling of the SDK bridge turn lookup. A leg's request id is on screen as
 * soon as the request is, and the turn row can land a moment later, so a
 * lookup that finds nothing asks again for a while instead of settling on
 * "not found".
 */

import { describe, expect, it } from "bun:test";
import type { SdkBridgeTurnView } from "@clankermux/types";
import { queryKeys } from "../lib/query-keys";
import { sdkBridgeTurnQueryOptions } from "./queries";

type Data = SdkBridgeTurnView | null | undefined;
const query = (data: Data) => ({ state: { data } });
const view = (status: string) =>
	({ turn: { status } }) as unknown as SdkBridgeTurnView;

describe("sdkBridgeTurnQueryOptions", () => {
	const startedAt = 1_000_000;
	const at = (ms: number) => () => startedAt + ms;

	it("polls every 2 s while nothing is found, for 60 s from the lookup's start", () => {
		expect(
			sdkBridgeTurnQueryOptions("leg-1", startedAt, at(0)).refetchInterval(
				query(null),
			),
		).toBe(2_000);
		expect(
			sdkBridgeTurnQueryOptions("leg-1", startedAt, at(59_999)).refetchInterval(
				query(null),
			),
		).toBe(2_000);
		expect(
			sdkBridgeTurnQueryOptions("leg-1", startedAt, at(60_000)).refetchInterval(
				query(null),
			),
		).toBe(false);
	});

	it("counts the window from its own start, so a new id polls afresh", () => {
		const later = startedAt + 120_000;
		expect(
			sdkBridgeTurnQueryOptions("leg-2", later, at(125_000)).refetchInterval(
				query(null),
			),
		).toBe(2_000);
	});

	it("never serves a cached 'not found' as fresh", () => {
		const options = sdkBridgeTurnQueryOptions("leg-1", startedAt, at(0));
		expect(options.staleTime(query(null))).toBe(0);
		expect(options.staleTime(query(view("completed")))).toBe(5_000);
	});

	it("keeps polling a running turn every 5 s, and stops once it is over", () => {
		const options = sdkBridgeTurnQueryOptions("t", startedAt, at(600_000));
		expect(options.refetchInterval(query(view("running")))).toBe(5_000);
		expect(options.refetchInterval(query(view("completed")))).toBe(false);
		// Still loading: the fetch in flight decides.
		expect(options.refetchInterval(query(undefined))).toBe(false);
	});

	it("keys on the id", () => {
		expect(sdkBridgeTurnQueryOptions("t", startedAt).queryKey).toEqual(
			queryKeys.sdkBridgeTurn("t"),
		);
	});
});
