import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	Link,
	MemoryRouter,
	Route,
	Routes,
	useLocation,
	useSearchParams,
} from "react-router";

/**
 * A smoke test for the react-router v8 upgrade: bundling the package proves
 * nothing about whether its hooks and components still work, so this actually
 * executes the router with the symbols the dashboard imports.
 *
 * Rendering is server-side (`renderToStaticMarkup`) to match the other tests in
 * this package, which run without a DOM. Two consequences:
 *  - `BrowserRouter` is unusable here (it reads `window.history`); `MemoryRouter`
 *    is its in-memory equivalent and drives the same routing internals.
 *  - `<Navigate>` navigates from an effect, and static rendering never runs
 *    effects, so redirect behaviour is deliberately not asserted.
 */
function Probe() {
	const location = useLocation();
	const [searchParams] = useSearchParams();
	return (
		<div>
			<span data-testid="pathname">{location.pathname}</span>
			<span data-testid="tab">{searchParams.get("tab") ?? "none"}</span>
			<Link to="/limits">Limits</Link>
		</div>
	);
}

function renderAt(entry: string): string {
	return renderToStaticMarkup(
		<MemoryRouter initialEntries={[entry]}>
			<Routes>
				<Route path="/analytics" element={<Probe />} />
				<Route path="/other" element={<span>other page</span>} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("react-router v8 smoke test", () => {
	it("renders the element of the route matching the current path", () => {
		const html = renderAt("/analytics");
		expect(html).toContain('data-testid="pathname"');
		expect(html).not.toContain("other page");
	});

	it("does not render a route whose path does not match", () => {
		const html = renderAt("/other");
		expect(html).toContain("other page");
		expect(html).not.toContain('data-testid="pathname"');
	});

	it("exposes the current path through useLocation", () => {
		const html = renderAt("/analytics");
		expect(html).toContain('<span data-testid="pathname">/analytics</span>');
	});

	it("reads a query parameter off the entry URL through useSearchParams", () => {
		const html = renderAt("/analytics?tab=costs");
		expect(html).toContain('<span data-testid="tab">costs</span>');
	});

	it("falls back when the query parameter is absent", () => {
		const html = renderAt("/analytics");
		expect(html).toContain('<span data-testid="tab">none</span>');
	});

	it("renders a Link as an anchor pointing at its target", () => {
		const html = renderAt("/analytics");
		expect(html).toContain('href="/limits"');
		expect(html).toContain("Limits");
	});
});
