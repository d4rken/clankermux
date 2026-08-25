/**
 * The client-side setup note on the Models page.
 *
 * Curation is only half the job: a client that was never told to read the list
 * ignores it, and the failure is silent in both CLIs — Claude Code skips the
 * fetch entirely without the flag, and the Codex CLI falls back to the
 * catalogue built into its own binary. So what is asserted here is that the
 * page names the thing the operator has to go and do, per dialect, and that it
 * stays COLLAPSED: the note is reference material, not something to read again
 * on every visit.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientSetupNote } from "./ClientSetupNote";

function render(dialect: "anthropic" | "openai"): string {
	return renderToStaticMarkup(<ClientSetupNote dialect={dialect} />);
}

describe("ClientSetupNote", () => {
	it("names the environment variable Claude Code needs", () => {
		const html = render("anthropic");
		expect(html).toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
		expect(html).toContain("ANTHROPIC_BASE_URL");
		expect(html).toContain("/wire/anthropic");
	});

	it("tells the Anthropic reader the list is only re-read at startup", () => {
		// The edit-then-nothing-happens trap: the operator hides a model, looks at
		// the running session's picker, and sees it still there.
		expect(render("anthropic")).toContain("gateway-models.json");
	});

	it("points the Codex reader at its provider config, not an env flag", () => {
		const html = render("openai");
		expect(html).toContain("config.toml");
		expect(html).toContain("/wire/openai/v1");
		expect(html).toContain("wire_api");
		expect(html).not.toContain("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
	});

	it("warns that Codex curation needs a reachable Codex account", () => {
		// Without one the route answers in the OpenAI list shape, which Codex
		// cannot deserialize, so every hide and rename is silently discarded. Pool
		// membership is not the condition: the catalogue read filters by pause
		// state and by the requesting key's pin, so the note has to say SCOPE.
		const html = render("openai");
		expect(html).toContain("Codex account");
		expect(html).toContain("routing scope");
	});

	it("tells the Codex reader to set the key env_key only names", () => {
		// The provider stanza declares env_key; a copied config with no variable
		// behind it authenticates with nothing.
		expect(render("openai")).toContain("CLANKERMUX_API_KEY");
	});

	it("does not present shell syntax as the settings.json form", () => {
		// The snippet is `export …`, which is not valid JSON; the settings.json
		// route has to be named as an alternative, not as the same bytes.
		const html = render("anthropic");
		expect(html).toContain("settings.json");
		expect(html).toContain("shell syntax");
	});

	it("stays collapsed", () => {
		for (const dialect of ["anthropic", "openai"] as const) {
			const html = render(dialect);
			expect(html).toContain("<details");
			expect(html).not.toContain("<details open");
		}
	});
});
