import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_PI_PROMPT_VERSIONS } from "../pi-prompt";
import {
	dropSystemPromptPolicy,
	piProjectionSystemPromptPolicy,
	type SystemPromptOutcome,
	selectSystemPromptPolicy,
} from "../system-prompt-policy";
import {
	expectedAppend,
	loadPiPromptFixtures,
	PI_PROMPT_FIXTURES,
	type PiPromptFixture,
} from "./fixtures/pi-prompt-fixtures";

function decide(system: string, version: string | null = "0.87") {
	return piProjectionSystemPromptPolicy.decide(system, {
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

const fixture = (version: string, name: string): PiPromptFixture => {
	const found = loadPiPromptFixtures(version).find((f) => f.name === name);
	if (!found) throw new Error(`no fixture ${name}`);
	return found;
};

describe("policy selection", () => {
	it("projects pi's prompt and drops every other client's", () => {
		expect(selectSystemPromptPolicy("pi").name).toBe("pi-projection-v1");
		for (const harness of ["opencode", "codex", "oh-my-pi", null])
			expect(selectSystemPromptPolicy(harness).name).toBe("drop");
	});

	it("drop never appends, whatever the text", () => {
		const system = fixture("0.87", "stock-all").system;
		expect(
			dropSystemPromptPolicy.decide(system, {
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

describe("fixtures", () => {
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
				if (f.expect.outcome === "projected") {
					expect(appendOf(outcome)).toBe(expectedAppend(f));
					expect(outcome.detail).toEqual({
						outcome: "projected",
						version,
						shape: f.expect.shape,
						droppedSections: f.expect.droppedSections,
						sectionUpdates: f.expect.sectionUpdates,
					});
					return;
				}
				const refused = refusalOf(outcome);
				expect(refused.error).toMatchObject({
					status: 400,
					type: "invalid_request_error",
					code: f.expect.code,
				});
				expect(refused.error.message).toContain("pi-projection-v1");
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

describe("pi 0.87 projection", () => {
	it("keeps no stock preamble, tools, rules or docs", () => {
		const append = appendOf(decide(fixture("0.87", "stock-all").system));
		for (const text of [
			"You are an expert coding assistant",
			"<tools>",
			"<rules>",
			"<docs>",
			"docs/packages.md",
		])
			expect(append).not.toContain(text);
		expect(append).toStartWith("<project_context>\n");
		expect(append).toEndWith("<cwd>\n/home/user/projects/widget\n</cwd>");
	});

	it("keeps pi's order: project context, skills, addendum, cwd", () => {
		const f = fixture("0.87", "stock-all");
		const append = appendOf(decide(f.system)) ?? "";
		const at = ["project_context", "skills", "addendum", "cwd"].map((name) =>
			append.indexOf(`<${name}>\n`),
		);
		expect(at.every((i) => i >= 0)).toBe(true);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
	});

	it("delivers a context file byte for byte", () => {
		const f = fixture("0.87", "context-verbatim");
		const append = appendOf(decide(f.system)) ?? "";
		const files = f.input.contextFiles as Array<{ content: string }>;
		for (const file of files) expect(append).toContain(file.content);
	});

	it("puts a replaced preamble first, verbatim", () => {
		for (const name of ["custom-prompt", "subagent-persona"]) {
			const f = fixture("0.87", name);
			const append = appendOf(decide(f.system)) ?? "";
			expect(append).toStartWith(`${f.input.customPrompt as string}\n\n<`);
			expect(append).not.toContain("<tools>");
		}
	});

	it("drops extension sections, recording only their names", () => {
		const f = fixture("0.87", "extension-section");
		const outcome = decide(f.system);
		expect(appendOf(outcome)).not.toContain("write tests");
		expect(appendOf(outcome)).not.toContain("<todo_list>");
		expect(outcome.detail).toMatchObject({
			droppedSections: ["todo_list", "web-search"],
		});
	});

	it("applies later section updates before projecting", () => {
		const f = fixture("0.87", "section-update");
		const append = appendOf(decide(f.system)) ?? "";
		expect(append).toContain("<name>deploy</name>");
		expect(append).toContain("packages/core/AGENTS.md");
		expect(append).not.toContain("<addendum>");
		expect(append).not.toContain("Updated system prompt section");
	});

	it("sends nothing for an empty prompt", () => {
		const outcome = decide("");
		expect(appendOf(outcome)).toBeNull();
		expect(outcome.detail).toMatchObject({ shape: "empty" });
	});

	it("never records or echoes the prompt text", () => {
		for (const f of loadPiPromptFixtures("0.87")) {
			if (f.expect.outcome !== "refused") continue;
			const refused = refusalOf(decide(f.system));
			const recorded = JSON.stringify(refused.detail) + refused.error.message;
			for (const line of f.system.split("\n"))
				if (line.length > 24) expect(recorded).not.toContain(line);
		}
	});
});

describe("pi 0.87 malformed grammar", () => {
	const stock = fixture("0.87", "stock-all").system;
	const custom = fixture("0.87", "custom-prompt").system;
	const block = (text: string, name: string) => {
		const start = text.indexOf(`\n\n<${name}>\n`);
		const end = text.indexOf(`\n</${name}>`, start) + `\n</${name}>`.length;
		return { start, end, text: text.slice(start, end) };
	};
	const without = (text: string, name: string) => {
		const b = block(text, name);
		return text.slice(0, b.start) + text.slice(b.end);
	};
	const cases: Array<[string, string, string, string | null]> = [
		[
			"a stock preamble without its tools",
			without(stock, "tools"),
			"stock_sections_missing",
			"tools",
		],
		[
			"a stock preamble alone",
			stock.slice(0, stock.indexOf("\n\n")),
			"stock_sections_missing",
			"tools",
		],
		["no cwd section", without(custom, "cwd"), "missing_section", "cwd"],
		[
			"a known section twice",
			`${stock.slice(0, block(stock, "cwd").start)}${block(stock, "skills").text}${stock.slice(block(stock, "cwd").start)}`,
			"duplicate_section",
			"skills",
		],
		[
			"a known section repeated after the others",
			`${stock}${block(stock, "tools").text}`,
			"duplicate_section",
			"tools",
		],
		[
			"sections out of pi's order",
			`${without(stock, "addendum").replace("\n\n<cwd>", `${block(stock, "addendum").text}\n\n<cwd>`)}`,
			"section_out_of_order",
			"addendum",
		],
		[
			"a truncated last section",
			stock.slice(0, -"\n</cwd>".length),
			"unterminated_section",
			"cwd",
		],
		[
			"free text after the sections",
			`${stock}\n\nPS: be nice`,
			"text_between_sections",
			null,
		],
		[
			"an update whose section is not the one it names",
			`${stock}\n\nUpdated system prompt section "skills":\n\n<cwd>\n/x\n</cwd>`,
			"malformed_section_update",
			"skills",
		],
		[
			"a section after an update",
			`${stock}\n\nRemoved system prompt section "addendum".\n\n<todo>\nx\n</todo>`,
			"malformed_section_update",
			null,
		],
	];
	for (const [what, system, reason, section] of cases)
		it(`refuses ${what}`, () => {
			const refused = refusalOf(decide(system));
			expect(refused.error.code).toBe("sdk_bridge_prompt_malformed");
			expect(refused.detail).toMatchObject({ reason, section });
		});
});

describe("the version gate", () => {
	const system = fixture("0.87", "stock").system;

	it("refuses a pi turn that declares no layout", () => {
		const refused = refusalOf(decide(system, null));
		expect(refused.error).toMatchObject({
			status: 400,
			code: "sdk_bridge_prompt_unsupported",
		});
		expect(refused.error.message).toContain("pi-projection-v1");
		expect(refused.error.message).toContain("x-clankermux-pi-prompt");
		expect(refused.detail).toMatchObject({
			version: null,
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
});
