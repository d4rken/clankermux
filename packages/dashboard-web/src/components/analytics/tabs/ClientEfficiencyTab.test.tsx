/**
 * The Clients analytics tab.
 *
 * The claims worth pinning are about PROVENANCE, not layout. An inferred
 * harness is a label for a row the proxy never measured, and the only reason
 * the database stores NULL instead of backfilling a guess is so that the
 * difference survives to this screen. These cases hold the chip, the
 * declared/detected mismatch and the truncation notice to that.
 */
import { describe, expect, it } from "bun:test";
import type {
	AnalyticsResponse,
	ClientEfficiencyRow,
	ClientModelEfficiencyRow,
} from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { canonicalSections } from "../../../lib/analytics-sections";
import { queryKeys } from "../../../lib/query-keys";
import { EMPTY_FILTERS } from "../AnalyticsFilters";
import {
	CLIENT_MODEL_MIN_REQUESTS,
	CLIENT_SECTIONS,
	ClientEfficiencyTab,
} from "./ClientEfficiencyTab";

const RANGE = "7d" as const;

function row(
	overrides: Partial<ClientEfficiencyRow> = {},
): ClientEfficiencyRow {
	return {
		apiKeyId: "key-1",
		apiKey: "laptop-key",
		harness: "claude-code",
		declaredApplication: "claude-code",
		requests: 10,
		successfulRequests: 9,
		observedRequests: 10,
		inferredSessionRequests: 0,
		inferredDeclaredRequests: 0,
		inputTokens: 1000,
		outputTokens: 200,
		cacheReadTokens: 4000,
		cacheCreationTokens: 500,
		costUsd: 0.5,
		pricedRequests: 10,
		unpricedRequests: 0,
		contextCoveredRequests: 10,
		contextTokensSum: 55_000,
		contextToolsCharsSum: 20_000,
		contextSystemCharsSum: 10_000,
		contextToolCountSum: 120,
		...overrides,
	};
}

function modelRow(
	overrides: Partial<ClientModelEfficiencyRow> = {},
): ClientModelEfficiencyRow {
	return {
		apiKeyId: "key-1",
		apiKey: "laptop-key",
		model: "claude-opus-4-8",
		requests: 10,
		inputTokens: 1000,
		outputTokens: 200,
		cacheReadTokens: 4000,
		cacheCreationTokens: 500,
		costUsd: 0.5,
		pricedRequests: 10,
		unpricedRequests: 0,
		...overrides,
	};
}

function payload(
	rows: ClientEfficiencyRow[],
	options: {
		truncated?: boolean;
		modelRows?: ClientModelEfficiencyRow[];
	} = {},
): AnalyticsResponse {
	return {
		meta: { range: RANGE, bucket: "1h", sections: ["clientEfficiency"] },
		clientEfficiency: { truncated: options.truncated ?? false, rows },
		clientModelEfficiency: options.modelRows ?? [],
	};
}

function render(analytics?: AnalyticsResponse): string {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnMount: false, retryOnMount: false },
		},
	});
	if (analytics) {
		queryClient.setQueryData(
			queryKeys.analytics(
				RANGE,
				EMPTY_FILTERS,
				"normal",
				false,
				canonicalSections(CLIENT_SECTIONS),
			),
			analytics,
		);
	}
	return renderToStaticMarkup(
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>
				<ClientEfficiencyTab
					filters={EMPTY_FILTERS}
					setFilters={() => {}}
					availableAccounts={[]}
					availableModels={[]}
					availableApiKeys={[]}
					availableProjects={[]}
					hasNoAccountBucket={false}
					hasNoProjectBucket={false}
					activeFilterCount={0}
					filterOpen={false}
					setFilterOpen={() => {}}
					range={RANGE}
					onRangeChange={() => {}}
				/>
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe("CLIENT_SECTIONS", () => {
	it("requests the section both panels are backed by", () => {
		// Without it the server omits the fields and both panels render empty,
		// which is indistinguishable from "no clients in range".
		expect(CLIENT_SECTIONS).toContain("clientEfficiency");
	});
});

describe("ClientEfficiencyTab harness chip", () => {
	it("marks a fully observed group as detected from headers", () => {
		const html = render(payload([row()]));

		expect(html).toContain("Client efficiency");
		expect(html).toContain("laptop-key");
		expect(html).toContain("Detected from request headers");
		expect(html).not.toContain("(inferred)");
	});

	it("marks a group holding any inferred row, naming the tiers", () => {
		const html = render(
			payload([
				row({
					observedRequests: 9,
					inferredSessionRequests: 1,
					inferredDeclaredRequests: 0,
				}),
			]),
		);

		expect(html).toContain("(inferred)");
		expect(html).toContain("Inferred from session identity");
	});

	it("names both tiers when both contributed", () => {
		const html = render(
			payload([
				row({
					observedRequests: 0,
					inferredSessionRequests: 5,
					inferredDeclaredRequests: 5,
				}),
			]),
		);

		expect(html).toContain("Inferred from session identity");
		expect(html).toContain(
			"Inferred from the client&#x27;s configured application",
		);
	});

	it("labels a group with no resolved harness Unknown", () => {
		const html = render(
			payload([
				row({
					harness: null,
					declaredApplication: null,
					observedRequests: 0,
					inferredSessionRequests: 0,
					inferredDeclaredRequests: 0,
				}),
			]),
		);

		expect(html).toContain("Unknown");
		expect(html).toContain("No harness could be identified");
	});

	it("reports a client split across two harnesses with a +N suffix", () => {
		const html = render(
			payload([
				row({ harness: "claude-code", requests: 8, observedRequests: 8 }),
				row({ harness: "codex", requests: 2, observedRequests: 2 }),
			]),
		);

		// The dominant harness names the row; the rest are counted, not hidden.
		expect(html).toContain("+1");
		expect(html).toContain("Harnesses in this group: claude-code, codex");
	});
});

describe("ClientEfficiencyTab mismatch badge", () => {
	it("flags a fully observed harness that contradicts the declared application", () => {
		const html = render(
			payload([row({ harness: "codex", declaredApplication: "claude-code" })]),
		);

		expect(html).toContain("configured as claude-code");
	});

	it("stays silent when the group carries inferred rows", () => {
		// A declared-tier inference IS the declaration, so flagging it would have
		// the row contradict itself.
		const html = render(
			payload([
				row({
					harness: "codex",
					declaredApplication: "claude-code",
					observedRequests: 0,
					inferredSessionRequests: 0,
					inferredDeclaredRequests: 10,
				}),
			]),
		);

		expect(html).not.toContain("configured as");
	});

	it("stays silent when the observed harness is not a known application", () => {
		// `openai` is what an SDK calls itself, not a claim about configuration.
		const html = render(
			payload([row({ harness: "openai", declaredApplication: "claude-code" })]),
		);

		expect(html).not.toContain("configured as");
	});

	it("stays silent for a generic declaration, which declares nothing", () => {
		const html = render(
			payload([row({ harness: "codex", declaredApplication: "generic" })]),
		);

		expect(html).not.toContain("configured as");
	});
});

describe("ClientEfficiencyTab notices", () => {
	it("says so when the server truncated the client rows", () => {
		const html = render(payload([row()], { truncated: true }));
		expect(html).toContain("maximum number of client rows");
	});

	it("omits the truncation notice on a complete result", () => {
		const html = render(payload([row()]));
		expect(html).not.toContain("maximum number of client rows");
	});

	it("reports unpriced requests so a pricing gap is not read as free usage", () => {
		const html = render(
			payload([row({ pricedRequests: 6, unpricedRequests: 4 })]),
		);
		expect(html).toContain("Cost coverage in this range");
		expect(html).toContain("4 requests unpriced");
	});

	it("renders the empty state when the section is present but has no rows", () => {
		const html = render(payload([]));
		expect(html).toContain("No client activity in this range");
		expect(html).not.toContain("Some panels are unavailable");
	});

	it("says the section is missing rather than drawing an empty panel", () => {
		const html = render({
			meta: { range: RANGE, bucket: "1h", sections: ["totals"] },
		});
		expect(html).toContain("Some panels are unavailable");
		expect(html).toContain("clientEfficiency");
	});
});

describe("ClientModelEfficiencyPanel", () => {
	it("groups the rows by model and states the request floor", () => {
		const html = render(
			payload([row()], {
				modelRows: [
					modelRow({ apiKeyId: "key-1", apiKey: "laptop-key" }),
					modelRow({
						apiKeyId: "key-2",
						apiKey: "server-key",
						cacheReadTokens: 0,
						cacheCreationTokens: 3000,
					}),
				],
			}),
		);

		expect(html).toContain("Same model, different clients");
		expect(html).toContain("server-key");
		expect(html).toContain(`fewer than ${CLIENT_MODEL_MIN_REQUESTS} requests`);
	});

	it("renders its own empty state without blanking the table above", () => {
		const html = render(payload([row()], { modelRows: [] }));
		expect(html).toContain(
			`No client reached ${CLIENT_MODEL_MIN_REQUESTS} requests on a single model`,
		);
		expect(html).toContain("laptop-key");
	});
});
