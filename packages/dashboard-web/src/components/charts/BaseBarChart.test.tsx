import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BaseBarChart } from "./BaseBarChart";

const DATA = [
	{ ts: "10:00", a: 3, b: 1 },
	{ ts: "11:00", a: 0, b: 2 },
];

/**
 * Recharts renders nothing measurable under `renderToStaticMarkup` (it needs a
 * laid-out container), so these assert on the element TREE rather than on
 * pixels: the props reached the `<Bar>` elements the chart builds.
 */
function barProps(bars: Parameters<typeof BaseBarChart>[0]["bars"]) {
	const element = BaseBarChart({ data: DATA, bars, xAxisKey: "ts" });
	const found: Array<Record<string, unknown>> = [];
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (node == null || typeof node !== "object") return;
		const el = node as {
			type?: { displayName?: string; name?: string };
			props?: Record<string, unknown>;
		};
		const name = el.type?.displayName ?? el.type?.name;
		if (name === "Bar") found.push(el.props ?? {});
		if (el.props?.children) walk(el.props.children);
	};
	walk(element);
	return found;
}

describe("BaseBarChart", () => {
	it("passes stackId through to the rendered bars", () => {
		// Without this the parts of one total are drawn side by side, and a bucket
		// of many small causes looks calmer than one large cause of the same
		// total.
		const props = barProps([
			{ dataKey: "a", stackId: "stops" },
			{ dataKey: "b", stackId: "stops" },
		]);

		expect(props).toHaveLength(2);
		expect(props[0].stackId).toBe("stops");
		expect(props[1].stackId).toBe("stops");
	});

	it("leaves stackId undefined for callers that do not stack", () => {
		const props = barProps([{ dataKey: "a" }]);

		expect(props).toHaveLength(1);
		expect(props[0].stackId).toBeUndefined();
	});

	it("still renders", () => {
		const html = renderToStaticMarkup(
			<BaseBarChart
				data={DATA}
				xAxisKey="ts"
				bars={[{ dataKey: "a", stackId: "stops" }]}
			/>,
		);
		expect(html.length).toBeGreaterThan(0);
	});
});
