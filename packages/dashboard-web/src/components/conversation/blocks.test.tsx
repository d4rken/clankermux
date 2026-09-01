import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBlock } from "./ToolResultBlock";
import { ToolUsageBlock } from "./ToolUsageBlock";

/**
 * The three conversation blocks after they adopted the shared `Alert`.
 *
 * The claim R14 rests on is that their shell is unchanged — same tint, border,
 * radius and padding as the hand-rolled boxes, because `p-3` and `p-row` are
 * the same 0.75rem. A root-only assertion cannot hold that claim on its own:
 * the internals moved (the title grew from text-xs to text-sm, and the
 * header-to-body gap from 0.25rem to 0.5rem), and only header and body
 * structure catches a regression there.
 *
 * There is no pixel-diff primitive available, so this file is where the
 * "looks unchanged" residual lives.
 */

const LONG = "x".repeat(400);

describe("conversation block shells", () => {
	it("keeps each block's tint, border, radius and padding", () => {
		expect(renderToStaticMarkup(<ThinkingBlock content="short" />)).toContain(
			'class="rounded-lg border p-row bg-warning/10 border-warning/25"',
		);
		expect(renderToStaticMarkup(<ToolResultBlock content="short" />)).toContain(
			'class="rounded-lg border p-row bg-success/10 border-success/25"',
		);
		expect(
			renderToStaticMarkup(<ToolUsageBlock toolName="Read" input={{ a: 1 }} />),
		).toContain('class="rounded-lg border p-row bg-info/10 border-info/25"');
	});
});

describe("conversation block headers", () => {
	it("sets the title at Alert's size with the icon beside it", () => {
		const html = renderToStaticMarkup(<ThinkingBlock content="short" />);

		expect(html).toContain(
			'<div class="flex items-center gap-item"><span class="flex shrink-0 text-warning-strong">',
		);
		expect(html).toContain(
			'<p class="text-sm font-medium text-foreground">Thinking</p>',
		);
	});

	/**
	 * The one block whose icon keeps its own hue: Alert maps `info` icons to
	 * `text-foreground`, because `--info-strong` deliberately does not exist
	 * without a consumer.
	 */
	it("keeps the tool-usage icon on the info hue", () => {
		const html = renderToStaticMarkup(
			<ToolUsageBlock toolName="Bash" input={{ a: 1 }} />,
		);

		expect(html).toContain('class="lucide lucide-terminal w-3 h-3 text-info"');
		expect(html).toContain(
			'<p class="text-sm font-medium text-foreground">Tool: Bash</p>',
		);
	});

	it("puts the toggle in the header row, not below the title", () => {
		const html = renderToStaticMarkup(<ToolResultBlock content={LONG} />);

		expect(html).toContain(
			'<div class="flex items-center justify-between gap-item">',
		);
		expect(html).toMatch(
			/<\/p><\/div><span class="shrink-0"><button[^>]*>Show more<\/button><\/span><\/div>/,
		);
	});

	it("renders no header action at all when the content is short", () => {
		const html = renderToStaticMarkup(<ToolResultBlock content="short" />);

		expect(html).toContain('<div class="flex items-center gap-item">');
		expect(html).not.toContain("Show more");
		expect(html).not.toContain("justify-between");
	});

	/** h-6 across all three; ThinkingBlock used to be the h-5 outlier. */
	it("sizes all three toggles alike", () => {
		for (const html of [
			renderToStaticMarkup(<ThinkingBlock content={LONG} />),
			renderToStaticMarkup(<ToolResultBlock content={LONG} />),
			renderToStaticMarkup(
				<ToolUsageBlock toolName="Read" input={{ long: LONG }} />,
			),
		]) {
			expect(html).toContain("h-6 px-2");
			expect(html).not.toContain("h-5");
		}
	});
});

describe("conversation block bodies", () => {
	/**
	 * Alert's body wrapper supplies the top offset, so the child `mb-1`/`mt-1`
	 * the hand-rolled versions carried had to go — leaving them would have
	 * stacked 0.25rem on top of Alert's own 0.5rem.
	 */
	it("takes its top offset from Alert's body wrapper alone", () => {
		for (const html of [
			renderToStaticMarkup(<ThinkingBlock content="short" />),
			renderToStaticMarkup(<ToolResultBlock content="short" />),
			renderToStaticMarkup(<ToolUsageBlock toolName="Read" input={{ a: 1 }} />),
		]) {
			expect(html).toContain(
				'class="mt-item text-xs text-muted-foreground space-y-item"',
			);
			expect(html).not.toContain("mt-1 ");
			expect(html).not.toContain("mb-1");
		}
	});

	/**
	 * Tool output and tool input are the payload, not a note about it. Alert's
	 * body type is muted, so both blocks name `text-foreground` explicitly;
	 * dimming them would be a legibility regression rather than a restyle.
	 */
	it("keeps tool output and input at full contrast", () => {
		expect(renderToStaticMarkup(<ToolResultBlock content="short" />)).toContain(
			'class="bg-muted p-item rounded overflow-hidden text-foreground"',
		);
		expect(
			renderToStaticMarkup(<ToolUsageBlock toolName="Read" input={{ a: 1 }} />),
		).toContain("text-foreground");
	});

	it("omits the body entirely when a tool call carries no input", () => {
		const html = renderToStaticMarkup(<ToolUsageBlock toolName="Read" />);

		expect(html).toContain('<p class="text-sm font-medium text-foreground">');
		expect(html).not.toContain("space-y-item");
	});
});
