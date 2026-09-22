import { describe, expect, it } from "bun:test";
import type { ApiKeyResponse, ClientApplication } from "@clankermux/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { ClientLabel, clientLabelText } from "./ClientLabel";

function key(
	id: string,
	name: string,
	application: ClientApplication | null,
): ApiKeyResponse {
	return {
		id,
		name,
		application,
		prefixLast8: "12345678",
		createdAt: "2026-01-01T00:00:00.000Z",
		lastUsed: null,
		usageCount: 0,
		isActive: true,
		pinnedAccountId: null,
		pinnedProviders: null,
	};
}

function render(
	node: React.ReactElement,
	keys: ApiKeyResponse[] = [
		key("k-pi", "splurge", "pi"),
		key("k-codex", "splurge", "codex"),
		key("k-plain", "scripted", "generic"),
	],
): string {
	const query = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	query.setQueryData(queryKeys.apiKeys(), keys);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={query}>{node}</QueryClientProvider>,
	);
	query.clear();
	return html;
}

describe("ClientLabel", () => {
	it("draws different marks for two clients that share a name", () => {
		const pi = render(<ClientLabel apiKeyId="k-pi" name="splurge" />);
		const codex = render(<ClientLabel apiKeyId="k-codex" name="splurge" />);
		expect(pi).toContain("splurge");
		expect(codex).toContain("splurge");
		// The whole point: same label, different rendering. Comparing the <path>
		// rather than the whole markup keeps this about the mark and not about
		// incidental wrapper classes.
		const path = (html: string) => html.match(/ d="([^"]+)"/)?.[1];
		expect(path(pi)).toBeTruthy();
		expect(path(codex)).toBeTruthy();
		expect(path(pi)).not.toBe(path(codex));
	});

	it("names the harness for assistive technology, which cannot see the mark", () => {
		const html = render(<ClientLabel apiKeyId="k-pi" name="splurge" />);
		expect(html).toContain("sr-only");
		expect(html).toContain("Pi Agent");
		// The mark itself stays decorative — the sr-only text is what speaks.
		expect(html).toContain('aria-hidden="true"');
	});

	it("renders the bare name for a key it has never heard of", () => {
		// A hard-deleted key: the request row keeps a name snapshot, but no
		// profile survives to say what it was. An icon here would be a claim the
		// dashboard cannot support, and the terminal fallback would read as
		// "generic".
		const html = render(<ClientLabel apiKeyId="k-gone" name="retired" />);
		expect(html).toContain("retired");
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("sr-only");
	});

	it("renders the bare name when the row carries no key id at all", () => {
		const html = render(<ClientLabel apiKeyId={null} name="No key" />);
		expect(html).toContain("No key");
		expect(html).not.toContain("<svg");
	});

	it("prefers an application handed to it over the looked-up one", () => {
		// Callers holding a ClientView already know the answer and must not be
		// made to wait on a second query for it.
		const html = render(
			<ClientLabel apiKeyId="k-pi" name="splurge" application="opencode" />,
		);
		expect(html).toContain("OpenCode");
		expect(html).not.toContain("Pi Agent");
	});

	it("marks the unbranded harness rather than leaving a hole in the column", () => {
		const html = render(<ClientLabel apiKeyId="k-plain" name="scripted" />);
		expect(html).toContain("<svg");
		expect(html).toContain("Generic / script");
	});
});

describe("clientLabelText", () => {
	it("qualifies the name with the harness, for places that cannot draw", () => {
		expect(clientLabelText("splurge", "pi")).toBe("splurge (Pi Agent)");
		expect(clientLabelText("splurge", "codex")).toBe("splurge (Codex)");
	});

	it("leaves the name alone when the harness is unknown", () => {
		expect(clientLabelText("retired", null)).toBe("retired");
	});
});
