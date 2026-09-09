import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartTooltip } from "./ChartTooltip";

type Formatters = NonNullable<Parameters<typeof ChartTooltip>[0]["formatters"]>;

function renderValue(dataKey: string, formatters?: Formatters): string {
	return renderToStaticMarkup(
		<ChartTooltip
			active
			payload={[{ dataKey, value: 42, name: "Series" }]}
			formatters={formatters}
		/>,
	);
}

describe("ChartTooltip formatter lookup", () => {
	for (const key of [
		"__proto__",
		"constructor",
		"account_0",
		"other_accounts",
	]) {
		it(`uses the default formatter for unknown key ${key}`, () => {
			expect(
				renderValue(key, { default: (value) => `Fallback: ${value}` }),
			).toContain('<strong class="figure font-medium">Fallback: 42</strong>');
		});

		it(`shows the raw value for unknown key ${key} without a default`, () => {
			expect(renderValue(key)).toContain(
				'<strong class="figure font-medium">42</strong>',
			);
		});

		it(`honors an explicitly configured formatter for ${key}`, () => {
			expect(
				renderValue(key, {
					[key]: (value) => `Exact: ${value}`,
					default: () => "Fallback",
				}),
			).toContain('<strong class="figure font-medium">Exact: 42</strong>');
		});
	}
});
