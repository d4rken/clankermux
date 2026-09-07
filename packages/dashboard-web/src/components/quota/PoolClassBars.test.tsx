import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type PoolClassBar, PoolClassBars } from "./PoolClassBars";

function bar(over: Partial<PoolClassBar> = {}): PoolClassBar {
	return {
		accountId: "acc-1",
		name: "alpha",
		provider: "anthropic",
		pct: 48,
		state: "reporting",
		reason: null,
		resetMs: null,
		...over,
	};
}

describe("PoolClassBars", () => {
	it("keeps a blocked account's quota used visible and gray", () => {
		const html = renderToStaticMarkup(
			<PoolClassBars
				accounts={[bar({ state: "exhausted", reason: "5h limit reached" })]}
			/>,
		);
		expect(html).toContain('aria-valuenow="48"');
		expect(html).toContain(
			'aria-valuetext="alpha: 48% used · 5h limit reached"',
		);
		expect(html).toContain("width:48%");
		expect(html).toContain("bg-muted-foreground/30");
		expect(html).toContain("5h limit reached");
	});

	it("exposes a reading as a progressbar value", () => {
		const html = renderToStaticMarkup(
			<PoolClassBars accounts={[bar()]} leastUsedAccountId="acc-1" />,
		);
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-valuenow="48"');
		expect(html).toContain('aria-valuetext="alpha: 48% used"');
	});

	it("omits aria-valuenow entirely when there is no reading", () => {
		// ARIA spells "indeterminate" as an absent value. Emitting 0 here would
		// state the account is untouched, which is the opposite of "nobody has
		// polled it" — and the flattering one of the two.
		const html = renderToStaticMarkup(
			<PoolClassBars
				accounts={[
					bar({ pct: null, state: "unknown", reason: "no_usage_data" }),
				]}
			/>,
		);
		expect(html).not.toContain("aria-valuenow");
		expect(html).toContain('aria-valuetext="alpha: no reading"');
	});
});
