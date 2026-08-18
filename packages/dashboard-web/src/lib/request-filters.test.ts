import { describe, expect, it } from "bun:test";
import {
	buildRequestQueryParams,
	COMMON_STATUS_CODES,
	epochToLocalDateTime,
	isRequestFilterActive,
	localDateTimeToEpoch,
	mergeStatusCodes,
	presetRange,
	type RequestFilterState,
	requestQueryToSearchParams,
} from "./request-filters";

const emptyState: RequestFilterState = {
	status: "all",
	codes: [],
	account: null,
	apiKey: null,
	noApiKey: false,
	project: null,
	noProject: false,
	from: "",
	to: "",
};

describe("isRequestFilterActive", () => {
	it("is false for the empty state", () => {
		expect(isRequestFilterActive(emptyState)).toBe(false);
	});

	it("is true when any single filter is set", () => {
		expect(isRequestFilterActive({ ...emptyState, status: "error" })).toBe(
			true,
		);
		expect(isRequestFilterActive({ ...emptyState, codes: ["500"] })).toBe(true);
		expect(isRequestFilterActive({ ...emptyState, account: "acct" })).toBe(
			true,
		);
		expect(isRequestFilterActive({ ...emptyState, noApiKey: true })).toBe(true);
		expect(isRequestFilterActive({ ...emptyState, noProject: true })).toBe(
			true,
		);
		expect(isRequestFilterActive({ ...emptyState, project: "my-proj" })).toBe(
			true,
		);
		// A project genuinely named "all" is an active filter, not the
		// everything-selector it used to be mistaken for.
		expect(isRequestFilterActive({ ...emptyState, project: "all" })).toBe(true);
		expect(
			isRequestFilterActive({ ...emptyState, from: "2026-06-05T00:00" }),
		).toBe(true);
	});
});

describe("buildRequestQueryParams", () => {
	it("returns an empty object for the empty state", () => {
		expect(buildRequestQueryParams(emptyState)).toEqual({});
	});

	it("includes the status category when set", () => {
		expect(buildRequestQueryParams({ ...emptyState, status: "error" })).toEqual(
			{
				status: "error",
			},
		);
	});

	it("parses specific codes and drops the category when codes are present", () => {
		expect(
			buildRequestQueryParams({
				...emptyState,
				status: "success",
				codes: ["429", "500"],
			}),
		).toEqual({ codes: [429, 500] });
	});

	it("converts local datetime bounds to epoch ms", () => {
		const params = buildRequestQueryParams({
			...emptyState,
			from: "2026-06-05T12:00",
			to: "2026-06-05T13:00",
		});
		expect(params.from).toBe(new Date("2026-06-05T12:00").getTime());
		expect(params.to).toBe(new Date("2026-06-05T13:00").getTime());
	});

	it("includes account, apiKey, and project when they are set", () => {
		expect(
			buildRequestQueryParams({
				...emptyState,
				account: "acct",
				noApiKey: true,
				project: "my-proj",
			}),
		).toEqual({ account: "acct", noApiKey: true, project: "my-proj" });
	});

	it("passes the no-project bucket through as its own flag", () => {
		expect(buildRequestQueryParams({ ...emptyState, noProject: true })).toEqual(
			{ noProject: true },
		);
	});

	it("carries a project literally named 'all' through as a name", () => {
		expect(buildRequestQueryParams({ ...emptyState, project: "all" })).toEqual({
			project: "all",
		});
	});

	it("lets the empty buckets win over a name held alongside them", () => {
		expect(
			buildRequestQueryParams({
				...emptyState,
				apiKey: "my-key",
				noApiKey: true,
				project: "my-proj",
				noProject: true,
			}),
		).toEqual({ noApiKey: true, noProject: true });
	});
});

describe("requestQueryToSearchParams", () => {
	it("serializes only defined fields", () => {
		const qs = requestQueryToSearchParams({
			limit: 50,
			offset: 100,
			status: "error",
			from: 1000,
		}).toString();
		expect(qs).toBe("limit=50&offset=100&status=error&from=1000");
	});

	it("joins codes with commas", () => {
		const qs = requestQueryToSearchParams({ codes: [429, 500] }).toString();
		expect(qs).toBe("codes=429%2C500");
	});

	it("serializes the project filter", () => {
		const qs = requestQueryToSearchParams({ project: "my-proj" }).toString();
		expect(qs).toBe("project=my-proj");
	});

	it("serializes names literally, 'all' included", () => {
		// The old serializer dropped these three as sentinels, which turned a
		// filter on a real project named "all" into an unfiltered query.
		const qs = requestQueryToSearchParams({
			account: "all",
			apiKey: "all",
			project: "all",
		}).toString();
		expect(qs).toBe("account=all&apiKey=all&project=all");
	});

	it("serializes the empty buckets as their own flags", () => {
		expect(requestQueryToSearchParams({ noProject: true }).toString()).toBe(
			"noProject=1",
		);
		expect(requestQueryToSearchParams({ noApiKey: true }).toString()).toBe(
			"noApiKey=1",
		);
	});

	it("serializes an exact request id", () => {
		expect(
			requestQueryToSearchParams({ id: "req-1", limit: 1 }).toString(),
		).toBe("limit=1&id=req-1");
	});
});

describe("local datetime <-> epoch", () => {
	it("returns undefined for empty/invalid input", () => {
		expect(localDateTimeToEpoch("")).toBeUndefined();
		expect(localDateTimeToEpoch("not-a-date")).toBeUndefined();
	});

	it("round-trips a minute-aligned instant through local formatting", () => {
		// Pick a minute-aligned epoch; round-trip is timezone-independent because
		// both directions use local time.
		const ms = new Date("2026-06-05T12:34:00").getTime();
		expect(localDateTimeToEpoch(epochToLocalDateTime(ms))).toBe(ms);
	});
});

describe("presetRange", () => {
	it("returns null for an unknown preset", () => {
		expect(presetRange("bogus", new Date(0))).toBeNull();
	});

	it("computes a window ending at now for a known preset", () => {
		const now = new Date("2026-06-05T12:00:00");
		const range = presetRange("24h", now);
		expect(range).not.toBeNull();
		// 'to' is now; 'from' is 24h earlier — verify by decoding both back.
		expect(localDateTimeToEpoch(range?.to ?? "")).toBe(now.getTime());
		expect(localDateTimeToEpoch(range?.from ?? "")).toBe(
			now.getTime() - 24 * 60 * 60 * 1000,
		);
	});
});

describe("mergeStatusCodes", () => {
	it("includes the curated common codes", () => {
		const merged = mergeStatusCodes([]);
		expect(merged).toEqual([...COMMON_STATUS_CODES].sort((a, b) => a - b));
	});

	it("adds observed codes not in the common set, sorted and deduped", () => {
		const merged = mergeStatusCodes([200, 418, 429]);
		expect(merged).toContain(418);
		expect(merged.filter((c) => c === 200)).toHaveLength(1);
		expect(merged).toEqual([...merged].sort((a, b) => a - b));
	});
});
