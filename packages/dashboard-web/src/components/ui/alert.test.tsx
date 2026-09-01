import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Alert } from "./alert";

describe("Alert tones", () => {
	it("maps each tone to its documented container classes", () => {
		expect(renderToStaticMarkup(<Alert tone="info" title="t" />)).toContain(
			"bg-info/10 border-info/25",
		);
		expect(renderToStaticMarkup(<Alert tone="success" title="t" />)).toContain(
			"bg-success/10 border-success/25",
		);
		expect(renderToStaticMarkup(<Alert tone="warning" title="t" />)).toContain(
			"bg-warning/10 border-warning/25",
		);
		expect(
			renderToStaticMarkup(<Alert tone="destructive" title="t" />),
		).toContain("bg-destructive/10 border-destructive/25");
	});

	/**
	 * The icon takes the TEXT hue, never the fill hue: on a /10 tint over a card,
	 * `--success`/`--destructive` are fill values and fail as a foreground.
	 */
	it("tints the icon with the text hue, not the fill hue", () => {
		const success = renderToStaticMarkup(
			<Alert tone="success" title="t" icon={<svg role="presentation" />} />,
		);
		expect(success).toContain("text-success-strong");
		const warning = renderToStaticMarkup(
			<Alert tone="warning" title="t" icon={<svg role="presentation" />} />,
		);
		expect(warning).toContain("text-warning-strong");
		const destructive = renderToStaticMarkup(
			<Alert tone="destructive" title="t" icon={<svg role="presentation" />} />,
		);
		expect(destructive).toContain("text-destructive-strong");
		const info = renderToStaticMarkup(
			<Alert tone="info" title="t" icon={<svg role="presentation" />} />,
		);
		expect(info).toContain("text-foreground");
		expect(info).not.toContain("text-info");
	});

	/**
	 * One rule beats a conditional: the tint, border and icon carry the tone, so
	 * the title keeps maximum legibility in every tone — destructive included.
	 */
	it("keeps the title text-foreground in every tone", () => {
		for (const tone of ["info", "success", "warning", "destructive"] as const) {
			const html = renderToStaticMarkup(
				<Alert tone={tone} title="Warning">
					body
				</Alert>,
			);
			expect(html).toMatch(
				/class="[^"]*font-medium text-foreground[^"]*"[^>]*>Warning</,
			);
			expect(html).not.toContain("text-destructive-strong");
		}
	});
});

describe("Alert sizes", () => {
	it("renders the compact size by default", () => {
		const html = renderToStaticMarkup(<Alert title="Hint">body</Alert>);
		expect(html).toContain("p-row");
		expect(html).toContain("text-sm");
		expect(html).toContain("text-xs text-muted-foreground");
	});

	it("renders md roomier, with a foreground body", () => {
		const html = renderToStaticMarkup(
			<Alert size="md" tone="destructive" title="Warning">
				body
			</Alert>,
		);
		expect(html).toContain("p-group");
		expect(html).toContain("text-base");
		expect(html).toContain("text-sm text-foreground");
		expect(html).not.toContain("text-muted-foreground");
	});
});

describe("Alert body", () => {
	/**
	 * Four of the nine call sites are not title-plus-text: two embed a device-code
	 * chip and a link row, two embed a "Try again" button. The size's body classes
	 * set type and top offset but separate nothing WITHIN the body, so the
	 * wrapper's `space-y-item` is what keeps those children apart. A single-text
	 * body would not detect that regression.
	 */
	it("keeps space-y-item between multiple body children", () => {
		const html = renderToStaticMarkup(
			<Alert title="Waiting for authorization...">
				<p>Enter this code in the browser tab:</p>
				<div>
					<code>ABCD-EFGH</code>
				</div>
			</Alert>,
		);
		expect(html).toMatch(/class="[^"]*space-y-item[^"]*"/);
		expect(html).toContain("ABCD-EFGH");
	});

	it("omits the body wrapper when there are no children", () => {
		const html = renderToStaticMarkup(
			<Alert tone="success" title="Authorization successful! Account added." />,
		);
		expect(html).not.toContain("space-y-item");
	});
});

describe("Alert header shape", () => {
	/**
	 * Every other assertion in this file checks classes and content, never DOM
	 * SHAPE — so none of them would notice the header gaining a wrapper element.
	 * The `action` slot is a conditional branch precisely so the no-action case
	 * keeps emitting the flat header it emits today, and only full-string
	 * equality can hold that.
	 */
	it("emits byte-identical markup for the no-action case", () => {
		expect(
			renderToStaticMarkup(
				<Alert
					tone="warning"
					size="sm"
					title="Heads up"
					icon={<svg role="presentation" />}
				>
					<p>Body</p>
				</Alert>,
			),
		).toBe(
			'<div class="rounded-lg border p-row bg-warning/10 border-warning/25"><div class="flex items-center gap-item"><span class="flex shrink-0 text-warning-strong"><svg role="presentation"></svg></span><p class="text-sm font-medium text-foreground">Heads up</p></div><div class="mt-item text-xs text-muted-foreground space-y-item"><p>Body</p></div></div>',
		);
	});

	it("emits byte-identical markup with neither icon nor body", () => {
		expect(
			renderToStaticMarkup(
				<Alert tone="destructive" size="md" title="Broken" />,
			),
		).toBe(
			'<div class="rounded-lg border p-group bg-destructive/10 border-destructive/25"><div class="flex items-center gap-item"><p class="text-base font-medium text-foreground">Broken</p></div></div>',
		);
	});

	/**
	 * With an action the header becomes a `justify-between` row: icon and title
	 * in a shrinkable group on the left, the control pinned right. The control
	 * stays IN the header row — a conversation block's "Show more" toggle sitting
	 * below the title instead of beside it is the regression this holds.
	 */
	it("pins an action beside the title in a justify-between header", () => {
		const html = renderToStaticMarkup(
			<Alert
				tone="success"
				title="Tool result"
				action={<button type="button">Show more</button>}
			>
				<p>Body</p>
			</Alert>,
		);

		expect(html).toContain(
			'<div class="flex items-center justify-between gap-item">',
		);
		expect(html).toContain(
			'<div class="flex min-w-0 flex-1 items-center gap-item">',
		);
		expect(html).toMatch(
			/<p class="text-sm font-medium text-foreground">Tool result<\/p><\/div><span class="shrink-0"><button type="button">Show more<\/button><\/span><\/div>/,
		);
	});

	it("keeps the icon inside the action header's left group", () => {
		const html = renderToStaticMarkup(
			<Alert
				tone="warning"
				title="Thinking"
				icon={<svg role="presentation" />}
				action={<button type="button">Show less</button>}
			/>,
		);

		expect(html).toMatch(
			/<div class="flex min-w-0 flex-1 items-center gap-item"><span class="flex shrink-0 text-warning-strong">/,
		);
	});
});
