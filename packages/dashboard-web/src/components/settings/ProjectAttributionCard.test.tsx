import { describe, expect, it } from "bun:test";
import type { ProjectRulesGetResponse } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectAttributionCard } from "./ProjectAttributionCard";

function makeClient(): QueryClient {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function render(queryClient: QueryClient): string {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<ProjectAttributionCard />
		</QueryClientProvider>,
	);
}

function response(
	overrides: Partial<ProjectRulesGetResponse> = {},
): ProjectRulesGetResponse {
	return {
		roots: ["/home/*/projects", "/home/*"],
		overrides: [{ prefix: "/home/darken/.claude", name: ".claude" }],
		defaultRoots: ["/home/*/projects", "/home/*"],
		unmatched: [],
		...overrides,
	};
}

describe("ProjectAttributionCard", () => {
	it("renders the configured roots and overrides", () => {
		const client = makeClient();
		client.setQueryData(["project-rules"], response());
		const html = render(client);
		expect(html).toContain("/home/*/projects");
		expect(html).toContain("/home/darken/.claude");
		expect(html).toContain(".claude");
	});

	it("lists unmatched working directories with their counts", () => {
		const client = makeClient();
		client.setQueryData(
			["project-rules"],
			response({
				unmatched: [
					{ path: "/workspace/myrepo", count: 12, lastSeenAt: 1 },
					{ path: "/srv/thing", count: 3, lastSeenAt: 0 },
				],
			}),
		);
		const html = render(client);
		expect(html).toContain("/workspace/myrepo");
		expect(html).toContain("/srv/thing");
		expect(html).toContain(">12<");
	});

	it("says nothing was seen rather than showing an empty list", () => {
		// An empty list means "nothing recently", and the copy has to say so:
		// the tracker is in-memory, so it is also empty right after a restart.
		const client = makeClient();
		client.setQueryData(["project-rules"], response({ unmatched: [] }));
		expect(render(client)).toContain("No unmatched working directories seen");
	});

	it("states that an unconfigured layout is left unattributed", () => {
		// The behaviour change most likely to surprise an operator, so it must be
		// readable on the page rather than only in the commit.
		const client = makeClient();
		client.setQueryData(["project-rules"], response());
		expect(render(client)).toContain("left unattributed");
	});

	it("explains that an override is what enables a dot-leading directory", () => {
		const client = makeClient();
		client.setQueryData(["project-rules"], response());
		expect(render(client)).toContain("names beginning with a dot are rejected");
	});

	it("renders an empty-roots deployment without claiming rules exist", () => {
		const client = makeClient();
		client.setQueryData(["project-rules"], response({ roots: [] }));
		expect(render(client)).toContain("nothing is attributed by layout");
	});
});
