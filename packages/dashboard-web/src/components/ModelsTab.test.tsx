/**
 * Render states of the Models page.
 *
 * Static markup, so no effect ever runs and the query cache is seeded directly
 * — the same technique DataRetentionCard.test.tsx uses. What is checked here is
 * what the operator is TOLD: which baseline they are looking at (a live
 * Anthropic catalogue and this build's bundled fallback are different answers
 * to "why is that model missing"), and that a hidden entry is still on the page
 * at all, because the page is the only place it can be un-hidden.
 *
 * The interactions themselves live in ModelsTab.dom-test.tsx, and so does the
 * FAILED-read state: a static render cannot commit a field or fire a mutation,
 * and React Query's observer reports a seeded error as still-fetching on the
 * server, so an error branch is not observable in this lane at all.
 */

import { describe, expect, it } from "bun:test";
import type { ModelCatalogResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelsTab } from "./ModelsTab";

function client(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
}

function render(queryClient: QueryClient): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<ModelsTab />
		</QueryClientProvider>,
	);
}

function seed(queryClient: QueryClient, data: ModelCatalogResponse): void {
	queryClient.setQueryData(["model-catalog", "anthropic"], data);
}

function seedPending(queryClient: QueryClient): void {
	queryClient
		.getQueryCache()
		.build(queryClient, { queryKey: ["model-catalog", "anthropic"] })
		.setState({
			status: "pending",
			fetchStatus: "fetching",
			data: undefined,
			dataUpdatedAt: 0,
		});
}

function catalog(
	over: Partial<ModelCatalogResponse> = {},
): ModelCatalogResponse {
	return {
		baseline: { source: "upstream", fetchedAt: Date.now() - 12 * 60 * 1000 },
		rows: [
			{
				id: "claude-opus-5",
				displayName: "Claude Opus 5",
				source: "upstream",
				hidden: false,
				overrideDisplayName: null,
			},
		],
		...over,
	};
}

describe("ModelsTab", () => {
	it("names both wire mounts", () => {
		const queryClient = client();
		seed(queryClient, catalog());

		const html = render(queryClient);

		expect(html).toContain("/wire/anthropic");
		expect(html).toContain("/wire/openai");
	});

	it("says it is loading before the first read resolves", () => {
		const queryClient = client();
		seedPending(queryClient);

		expect(render(queryClient)).toContain("Loading models");
	});

	/**
	 * The loading state is a skeleton rather than a text line, and a bare
	 * Skeleton has no role and no accessible text — so the assertion above only
	 * still holds because the announcement moved to a visually hidden status
	 * line. This pins the other half of that: the region declares itself busy.
	 */
	it("marks the loading region busy for assistive technology", () => {
		const queryClient = client();
		seedPending(queryClient);

		const html = render(queryClient);

		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('<span class="sr-only" role="status">');
	});

	// "Missing because Anthropic no longer lists it" and "missing because this
	// build predates it" are different problems with different fixes.
	it("distinguishes a live catalogue from the bundled fallback", () => {
		const live = client();
		seed(live, catalog());
		expect(render(live)).toContain("Live Anthropic catalogue, fetched");

		const bundled = client();
		seed(
			bundled,
			catalog({ baseline: { source: "bundled", fetchedAt: null } }),
		);
		expect(render(bundled)).toContain("Bundled fallback list");
	});

	it("lists a model with its id and its served name", () => {
		const queryClient = client();
		seed(queryClient, catalog());

		const html = render(queryClient);

		expect(html).toContain("claude-opus-5");
		expect(html).toContain('value="Claude Opus 5"');
	});

	it("shows the override rather than the upstream name when renamed", () => {
		const queryClient = client();
		seed(
			queryClient,
			catalog({
				rows: [
					{
						id: "claude-opus-5",
						displayName: "House Model",
						source: "upstream",
						hidden: false,
						overrideDisplayName: "House Model",
					},
				],
			}),
		);

		expect(render(queryClient)).toContain('value="House Model"');
	});

	// A hidden row is dropped from the wire but must stay on the page: it is the
	// only place it can be brought back.
	it("keeps a hidden row on the page, dimmed and labelled", () => {
		const queryClient = client();
		seed(
			queryClient,
			catalog({
				rows: [
					{
						id: "claude-sonnet-5",
						displayName: "Claude Sonnet 5",
						source: "upstream",
						hidden: true,
						overrideDisplayName: null,
					},
				],
			}),
		);

		const html = render(queryClient);

		expect(html).toContain("claude-sonnet-5");
		expect(html).toContain("Hidden");
		expect(html).toContain("opacity-50");
	});

	it("marks a custom entry and offers to remove it", () => {
		const queryClient = client();
		seed(
			queryClient,
			catalog({
				rows: [
					{
						id: "claude-house",
						displayName: "House Special",
						source: "custom",
						hidden: false,
						overrideDisplayName: "House Special",
					},
				],
			}),
		);

		const html = render(queryClient);

		expect(html).toContain("Custom");
		expect(html).toContain("Remove claude-house");
	});

	it("offers the add-a-model form", () => {
		const queryClient = client();
		seed(queryClient, catalog());

		expect(render(queryClient)).toContain("Add custom model");
	});

	it("says so when the catalogue has no entries at all", () => {
		const queryClient = client();
		seed(queryClient, catalog({ rows: [] }));

		expect(render(queryClient)).toContain("No models in this catalogue yet");
	});
});
