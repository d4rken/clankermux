import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthorizationHandoff } from "./AuthorizationHandoff";

/**
 * The hand-off block is the only way back to an authorization URL now that
 * nothing opens automatically, so the anchor is the contract: a right-click
 * "copy link address" and a Copy button both have to yield the exact URL.
 */

const AUTH_URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=abc123&state=xyz";
// The static renderer escapes `&` to `&amp;` inside attributes, so compare
// against the escaped form rather than the raw URL.
const ESCAPED = AUTH_URL.replaceAll("&", "&amp;");

describe("AuthorizationHandoff", () => {
	it("renders the URL as a single external anchor with a copy button", () => {
		const html = renderToStaticMarkup(<AuthorizationHandoff url={AUTH_URL} />);

		const anchors = html.match(/<a\b/g) ?? [];
		expect(anchors.length).toBe(1);
		expect(html).toContain(`href="${ESCAPED}"`);
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain("Open authorization page");
		expect(html).toContain('title="Copy authorization link"');
		expect(html).not.toContain('title="Copy user code"');
		// The URL is a link, not printed text: it only ever appears in `href`.
		expect(html).not.toContain(`>${ESCAPED}<`);
	});

	it("renders the device-flow user code with its own copy button", () => {
		const html = renderToStaticMarkup(
			<AuthorizationHandoff url={AUTH_URL} userCode="ABCD-1234" />,
		);

		expect(html).toMatch(/<code[^>]*>ABCD-1234<\/code>/);
		expect(html).toContain('title="Copy user code"');
		expect(html).toContain('title="Copy authorization link"');
	});
});
