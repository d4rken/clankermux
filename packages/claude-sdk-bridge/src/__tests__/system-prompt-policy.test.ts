import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_PI_PROMPT_VERSIONS } from "@clankermux/types";
import { PI_PROMPT_HEAD_VERSIONS } from "../pi-prompt";
import {
	appendSystemPromptPolicy,
	dropSystemPromptPolicy,
	getSystemPromptPolicy,
	piHeadSystemPromptPolicy,
	type SystemPromptOutcome,
	selectSystemPromptPolicy,
} from "../system-prompt-policy";
import {
	expectedAppend,
	loadPiPromptFixture,
	loadPiPromptFixtures,
	PI_PROMPT_FIXTURES,
} from "./fixtures/pi-prompt-fixtures";

function decide(system: string, version: string | null = "0.87") {
	return piHeadSystemPromptPolicy.decide(system, {
		model: "claude-sonnet-5",
		clientHarness: "pi",
		piPromptVersion: version,
	});
}

function refusalOf(outcome: SystemPromptOutcome) {
	if (outcome.ok) throw new Error("expected a refusal");
	return outcome;
}

function appendOf(outcome: SystemPromptOutcome): string | null {
	if (!outcome.ok)
		throw new Error(`refused: ${outcome.error.code} ${outcome.error.message}`);
	return outcome.decision.append;
}

const fixture = (name: string) => loadPiPromptFixture("0.87", name);

describe("policy selection", () => {
	const select = (harness: string | null, application: string | null) =>
		selectSystemPromptPolicy(harness, application).name;

	it("appends an unidentified client's prompt on a generic key or none", () => {
		for (const harness of ["go-http-client", "curl", "openai", null])
			for (const application of ["generic", null])
				expect(select(harness, application)).toBe("append-v1");
	});

	it("drops a known agent harness's prompt, whatever the key declares", () => {
		for (const harness of [
			"opencode",
			"codex",
			"oh-my-pi",
			"qwen-code",
			"claude-code",
		])
			for (const application of ["generic", null, harness])
				expect(select(harness, application)).toBe("drop");
	});

	it("drops the prompt of a key declaring an agent, whatever the user-agent", () => {
		for (const application of ["codex", "opencode", "claude-code", "pi"])
			expect(select("curl", application)).toBe("drop");
	});

	it("strips pi's head from pi's prompt", () => {
		for (const application of ["pi", "generic", null])
			expect(select("pi", application)).toBe("pi-head-v1");
	});

	it("drop never appends, whatever the text", () => {
		expect(
			dropSystemPromptPolicy.decide(fixture("stock-all").system, {
				model: "m",
				clientHarness: "pi",
				piPromptVersion: "0.87",
			}),
		).toEqual({
			ok: true,
			decision: { append: null, excludeDynamicSections: false },
			detail: null,
		});
	});
});

describe("append-v1", () => {
	const turn = {
		model: "m",
		clientHarness: "curl",
		piPromptVersion: null,
	};

	it("appends the client's text unchanged and records its UTF-8 size", () => {
		const system = "You are a helper.\n\nAnswer in Français, 🙂.";
		expect(appendSystemPromptPolicy.decide(system, turn)).toEqual({
			ok: true,
			decision: { append: system, excludeDynamicSections: false },
			detail: {
				outcome: "appended",
				bytes: Buffer.byteLength(system, "utf8"),
			},
		});
	});

	it("sends the preset alone for an empty prompt", () => {
		expect(appendSystemPromptPolicy.decide("", turn)).toEqual({
			ok: true,
			decision: { append: null, excludeDynamicSections: false },
			detail: { outcome: "appended", bytes: 0 },
		});
	});

	it("is registered", () => {
		expect(getSystemPromptPolicy("append-v1")).toBe(appendSystemPromptPolicy);
	});
});

describe("fixtures", () => {
	it("records only defined section names from release and extension exports", () => {
		for (const version of SUPPORTED_PI_PROMPT_VERSIONS)
			for (const f of loadPiPromptFixtures(version))
				expect(Object.keys(f.sections ?? {})).not.toContain("undefined");
	});

	it("covers current extension hooks and generic updates without the retired hook", () => {
		const fixtures = loadPiPromptFixtures("1.3");
		const names = fixtures.map((f) => f.name);
		expect(names).not.toContain("claude-context-section");
		for (const name of [
			"forced-claude-context",
			"forced-claude-context-and-agents",
		]) {
			const f = loadPiPromptFixture("1.3", name);
			expect(f.sections).toBeNull();
			expect(expectedAppend(f)).toContain(
				"## Claude supplemental guidance (claude-context)\n",
			);
		}
		for (const name of [
			"stock-extension-section",
			"collapsed-section-update",
			"collapsed-extension-section-update",
		])
			expect(names).toContain(name);
	});

	it("cover a head for exactly the versions discovery publishes", () => {
		expect([...PI_PROMPT_HEAD_VERSIONS].sort()).toEqual(
			[...SUPPORTED_PI_PROMPT_VERSIONS].sort(),
		);
	});

	it("exist for exactly the supported layouts, each generated from its pi release", () => {
		expect(readdirSync(PI_PROMPT_FIXTURES).sort()).toEqual(
			[...SUPPORTED_PI_PROMPT_VERSIONS].sort(),
		);
		for (const version of SUPPORTED_PI_PROMPT_VERSIONS) {
			const manifest = JSON.parse(
				readFileSync(
					join(PI_PROMPT_FIXTURES, version, "manifest.json"),
					"utf8",
				),
			) as {
				layout: string;
				piCodingAgentVersion: string;
				packageSha256: string;
				cases: string[];
			};
			expect(manifest.layout).toBe(version);
			expect(manifest.piCodingAgentVersion).toStartWith(`${version}.`);
			expect(manifest.packageSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(
				loadPiPromptFixtures(version)
					.map((f) => f.name)
					.sort(),
			).toEqual([...manifest.cases].sort());
		}
	});
});

for (const version of SUPPORTED_PI_PROMPT_VERSIONS)
	describe(`pi ${version} fixtures`, () => {
		for (const f of loadPiPromptFixtures(version))
			it(`${f.name}: ${f.description}`, () => {
				const outcome = decide(f.system, version);
				if (f.expect.outcome === "forwarded") {
					expect(appendOf(outcome)).toBe(f.expect.forwarded);
					expect(outcome.detail).toMatchObject({
						outcome: "forwarded",
						version,
						headStripped: f.expect.headStripped,
						forwardedLength: f.expect.forwarded?.length ?? 0,
					});
					return;
				}
				const refused = refusalOf(outcome);
				expect(refused.error).toMatchObject({
					status: 400,
					type: "invalid_request_error",
					code: f.expect.code,
				});
				expect(refused.error.message).toContain("pi-head-v1");
				expect(refused.detail).toEqual({
					outcome: "refused",
					version,
					code: f.expect.code,
					reason: f.expect.reason,
					section: f.expect.section,
					promptLength: f.system.length,
					promptSha256: createHash("sha256").update(f.system).digest("hex"),
				});
			});
	});

describe("pi 0.87 head strip", () => {
	it("forwards everything after the head, and nothing of it", () => {
		const f = fixture("stock-all");
		const append = appendOf(decide(f.system)) ?? "";
		for (const text of [
			"You are an expert coding assistant",
			"<tools>",
			"<rules>",
			"<docs>",
			"docs/packages.md",
		])
			expect(append).not.toContain(text);
		expect(f.system.endsWith(append)).toBe(true);
		expect(append).toStartWith("<addendum>\n");
		expect(append).toEndWith("<cwd>\n/home/user/projects/widget\n</cwd>");
	});

	it("delivers a context file byte for byte", () => {
		const f = fixture("context-verbatim");
		const append = appendOf(decide(f.system)) ?? "";
		const files = f.input.contextFiles as Array<{ content: string }>;
		for (const file of files) expect(append).toContain(file.content);
	});

	it("forwards a replaced preamble or a forced prompt without a head whole", () => {
		for (const name of ["custom-prompt", "subagent-persona", "forced-prompt"]) {
			const f = fixture(name);
			expect(appendOf(decide(f.system))).toBe(f.system);
		}
	});

	it("forwards what extensions append after pi's prompt", () => {
		const block =
			fixture("claude-context-section").sections?.["claude-context"] ?? "";
		expect(block).toStartWith(
			"## Claude supplemental guidance (claude-context)\n",
		);
		expect(appendOf(decide(fixture("forced-claude-context").system))).toEndWith(
			`</cwd>\n\n${block}`,
		);
		expect(
			appendOf(decide(fixture("claude-context-section").system)),
		).toEndWith(`</todo_list>\n\n${block}`);
		const agents = appendOf(decide(fixture("forced-advertised-agents").system));
		expect(agents).toEndWith("</advertised_subagents>");
		const outcome = decide(fixture("stock-extension-section").system);
		expect(appendOf(outcome)).toContain("<working_directory>\n");
		expect(outcome.detail).toMatchObject({
			sectionsSeen: [
				"project_context",
				"cwd",
				"todo_list",
				"working_directory",
			],
		});
	});

	it("strips the head of what pi sends after a mid-session tools change", () => {
		const f = fixture("collapsed-tools-change");
		const append = appendOf(decide(f.system)) ?? "";
		expect(append).not.toContain("<tools>");
		expect(append).toContain("<project_context>\n");
	});

	it("refuses a session gone back to stock, whose collapsed head is split", () => {
		// pi's collapse keeps the preamble's place and appends tools, rules and
		// docs at the end. Agreed with the pi side: no extension of theirs does this.
		const f = fixture("collapsed-custom-to-stock-refused");
		expect(f.system).toEndWith("</docs>");
		expect(refusalOf(decide(f.system)).detail).toMatchObject({
			code: "sdk_bridge_prompt_malformed",
			reason: "incomplete_head",
		});
	});

	it("strips the head of a herdr child, whose boundary text follows pi's prompt", () => {
		const f = fixture("herdr-child");
		expect(f.system).toStartWith("You are an expert coding assistant");
		const append = appendOf(decide(f.system)) ?? "";
		expect(append).toContain(
			"\n\nYou are a child subagent, not the parent orchestrator.\n",
		);
		expect(append).toEndWith(
			'<active_agent name="reviewer"/>\n\nYou are the reviewer agent.',
		);
	});

	it("refuses child boundary text placed before pi's head", () => {
		const system = `You are a child subagent, not the parent orchestrator.\n\n${fixture("stock").system}`;
		expect(refusalOf(decide(system)).detail).toMatchObject({
			code: "sdk_bridge_prompt_refused",
			reason: "trigger_preamble",
		});
	});

	it("refuses a subagent persona appended after the head that closes a head section again", () => {
		const f = fixture("subagent-append-closes-rules");
		expect(f.system).toStartWith("You are an expert coding assistant");
		expect(refusalOf(decide(f.system)).detail).toMatchObject({
			code: "sdk_bridge_prompt_malformed",
			reason: "duplicate_closing_tag",
			section: "rules",
		});
	});

	it("forwards update-message text after the head untouched", () => {
		const tail =
			'\n\nUpdated system prompt section "skills":\n\n<skills>\nk\n</skills>';
		const f = fixture("stock");
		expect(appendOf(decide(f.system + tail))).toBe(
			`${(f.expect as { forwarded: string }).forwarded}${tail}`,
		);
	});

	it("refuses the docs pair only together", () => {
		const custom = fixture("custom-prompt").system;
		for (const one of ["docs/custom-provider.md", "docs/packages.md"])
			expect(appendOf(decide(`${custom}\n\nSee ${one}.`))).toBe(
				`${custom}\n\nSee ${one}.`,
			);
	});

	it("forwards a mid-line mention of pi's preamble line", () => {
		// Only a line starting with it is pi's prompt, as in pi-claude-bridge's preambleAtLineStart.
		const text =
			"Persona. pi's prompt opens with: You are an expert coding assistant operating inside pi.";
		expect(appendOf(decide(text))).toBe(text);
	});

	it("sends nothing for an empty prompt", () => {
		const outcome = decide("");
		expect(appendOf(outcome)).toBeNull();
		expect(outcome.detail).toMatchObject({
			headStripped: false,
			forwardedLength: 0,
		});
	});

	it("never records or echoes the prompt text", () => {
		for (const version of SUPPORTED_PI_PROMPT_VERSIONS)
			for (const f of loadPiPromptFixtures(version)) {
				if (f.expect.outcome !== "refused") continue;
				const refused = refusalOf(decide(f.system, version));
				const recorded = JSON.stringify(refused.detail) + refused.error.message;
				for (const line of f.system.split("\n"))
					if (line.length > 24) expect(recorded).not.toContain(line);
			}
	});
});

describe("pi 0.99 head strip", () => {
	it("strips a docs section that lists MCP servers", () => {
		const f = loadPiPromptFixture("0.99", "stock-all");
		expect(f.system).toContain("MCP servers (docs/mcp.md)");
		const append = appendOf(decide(f.system, "0.99")) ?? "";
		expect(append).not.toContain("docs/mcp.md");
		expect(append).toBe(
			expectedAppend(loadPiPromptFixture("0.87", "stock-all")) as string,
		);
	});
});

describe("pi 1.0 head strip", () => {
	it("strips a docs section that points at codemode", () => {
		const f = loadPiPromptFixture("1.0", "stock-all");
		expect(f.system).toContain("(docs/codemode.md)");
		const append = appendOf(decide(f.system, "1.0")) ?? "";
		expect(append).not.toContain("docs/codemode.md");
		expect(append).toBe(
			expectedAppend(loadPiPromptFixture("0.87", "stock-all")) as string,
		);
	});

	it("strips a head whose tools are all hidden", () => {
		const f = loadPiPromptFixture("1.0", "stock-all-tools-hidden");
		expect(f.system).toContain("<tools>\n(none)\n\nIn addition");
		const append = appendOf(decide(f.system, "1.0"));
		expect(append).toBe(expectedAppend(f));
		expect(append).not.toContain("<tools>");
	});

	it("forwards the tool-less skills hint of a hidden reader", () => {
		const f = loadPiPromptFixture("1.0", "stock-skills-hidden-reader");
		const append = appendOf(decide(f.system, "1.0")) ?? "";
		expect(append).toStartWith(
			"<skills>\nThe following skills provide specialized instructions for specific tasks.\nLoad a skill's file when the task matches its description.\n",
		);
	});
});

describe("pi 0.87 malformed heads", () => {
	const stock = fixture("stock").system;
	const cut = (text: string, from: string, to: string) =>
		text.slice(0, text.indexOf(from)) + text.slice(text.indexOf(to));
	const cases: Array<[string, string, string, string | null]> = [
		[
			"a stock preamble alone",
			stock.slice(0, stock.indexOf("\n\n")),
			"incomplete_head",
			null,
		],
		[
			"a stock preamble without its rules",
			cut(stock, "\n\n<rules>\n", "\n\n<docs>\n"),
			"incomplete_head",
			null,
		],
		[
			"a stock preamble followed by other text",
			`${stock.slice(0, stock.indexOf("\n\n"))}\n\nBe brief.`,
			"incomplete_head",
			null,
		],
		[
			"a head section left open",
			stock.replace("\n</rules>", "\n</rulez>"),
			"incomplete_head",
			null,
		],
		[
			"a second </rules> in the tail",
			`${stock}\n\nThe tag </rules> ends pi's rules.`,
			"duplicate_closing_tag",
			"rules",
		],
		[
			"a tools update after the head, whose </tools> is a second one",
			`${stock}\n\nUpdated system prompt section "tools":\n\n<tools>\n- x\n</tools>`,
			"duplicate_closing_tag",
			"tools",
		],
		[
			"two </docs> in a replaced prompt",
			"Persona.\n\n</docs> and </docs>",
			"duplicate_closing_tag",
			"docs",
		],
	];
	for (const [what, system, reason, section] of cases)
		it(`refuses ${what}`, () => {
			const refused = refusalOf(decide(system));
			expect(refused.error.code).toBe("sdk_bridge_prompt_malformed");
			expect(refused.detail).toMatchObject({ reason, section });
		});

	it("allows one head closing tag in a prompt without pi's head", () => {
		expect(appendOf(decide("Persona mentioning </tools> once."))).toBe(
			"Persona mentioning </tools> once.",
		);
	});
});

describe("the version gate", () => {
	const system = fixture("stock").system;

	it("refuses a pi turn that declares no layout", () => {
		const refused = refusalOf(decide(system, null));
		expect(refused.error).toMatchObject({
			status: 400,
			code: "sdk_bridge_prompt_unsupported",
		});
		expect(refused.error.message).toContain("pi-head-v1");
		expect(refused.error.message).toContain("x-clankermux-pi-prompt");
		expect(refused.detail).toMatchObject({
			version: null,
			reason: "missing_version",
		});
	});

	it("treats an empty header as none", () => {
		expect(refusalOf(decide(system, "")).detail).toMatchObject({
			reason: "missing_version",
		});
	});

	it("refuses a layout it has no fixtures for, naming it", () => {
		const refused = refusalOf(decide(system, "0.88"));
		expect(refused.error.code).toBe("sdk_bridge_prompt_unsupported");
		expect(refused.error.message).toContain('"0.88"');
		expect(refused.error.message).toContain("0.87");
		expect(refused.detail).toMatchObject({
			version: "0.88",
			reason: "unsupported_version",
		});
	});

	for (const version of ["1.2", "1.3"])
		it(`serves ${version} with the same projection for the unchanged prompt grammar`, () => {
			const f = loadPiPromptFixture(version, "stock-all");
			expect(appendOf(decide(f.system, version))).toBe(expectedAppend(f));
		});

	for (const version of ["1.3.0", "v1.3", "1.3, 1.2", "1.4", "2.0"])
		it(`refuses unregistered layout ${version} instead of guessing compatibility`, () => {
			expect(refusalOf(decide(system, version)).error).toMatchObject({
				status: 400,
				code: "sdk_bridge_prompt_unsupported",
			});
		});

	it("serves 1.2 and still refuses 1.1, which sits between served layouts", () => {
		expect(appendOf(decide(system, "1.2"))).toBe(
			appendOf(decide(system, "1.0")),
		);
		const refused = refusalOf(decide(system, "1.1"));
		expect(refused.error.code).toBe("sdk_bridge_prompt_unsupported");
		expect(refused.error.message).toContain('"1.1"');
		expect(refused.detail).toMatchObject({
			version: "1.1",
			reason: "unsupported_version",
		});
	});
});
