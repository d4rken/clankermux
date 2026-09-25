import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_PI_PROMPT_VERSIONS } from "@clankermux/types";
import { PI_PROMPT_HEAD_VERSIONS } from "../pi-prompt";
import {
	dropSystemPromptPolicy,
	piHeadSystemPromptPolicy,
	type SystemPromptOutcome,
	selectSystemPromptPolicy,
} from "../system-prompt-policy";
import {
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
const expectedTail = (f: ReturnType<typeof fixture>) =>
	f.expect.outcome === "forwarded" ? (f.expect.forwarded ?? "") : "";

describe("policy selection", () => {
	it("strips pi's head from pi's prompt and drops every other client's", () => {
		expect(selectSystemPromptPolicy("pi").name).toBe("pi-head-v1");
		for (const harness of ["opencode", "codex", "oh-my-pi", null])
			expect(selectSystemPromptPolicy(harness).name).toBe("drop");
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

describe("fixtures", () => {
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
						removedUpdates: f.expect.removedUpdates,
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
		const context = appendOf(decide(fixture("forced-claude-context").system));
		expect(context).toContain("\n\n## Claude supplemental guidance\n");
		expect(context).toContain("Keep the public API stable.");
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
		expect(f.messages).toHaveLength(1);
		const append = appendOf(decide(f.system)) ?? "";
		expect(append).not.toContain("<tools>");
		expect(append).toContain("<project_context>\n");
	});

	it("refuses a session gone back to stock, whose collapsed head is split", () => {
		// pi's collapse keeps the preamble's place and appends tools, rules and
		// docs at the end; the pi side is being asked how to treat it.
		const f = fixture("collapsed-custom-to-stock-refused");
		expect(f.system).toEndWith("</docs>");
		expect(refusalOf(decide(f.system)).detail).toMatchObject({
			code: "sdk_bridge_prompt_malformed",
			reason: "incomplete_head",
		});
	});

	it("removes mid-conversation updates to the head and forwards the others", () => {
		expect(
			appendOf(decide(fixture("midconvo-update-tools").system)),
		).not.toContain("Updated system prompt section");
		const mixed = appendOf(
			decide(fixture("midconvo-update-tools-and-skills").system),
		);
		expect(mixed).toContain('Updated system prompt section "skills"');
		expect(mixed).not.toContain('"tools"');
		expect(
			appendOf(decide(fixture("midconvo-update-extension-section").system)),
		).toContain(
			'Updated system prompt section "claude_context":\n\n<claude_context>\nGuidance v2\n</claude_context>',
		);
		const back = decide(fixture("midconvo-update-preamble-to-stock").system);
		expect(appendOf(back)).not.toContain("Updated system prompt section");
		expect(back.detail).toMatchObject({ removedUpdates: 4 });
	});

	it("removes 50k head updates in linear time", () => {
		const f = fixture("stock");
		const update = (n: number) =>
			`\n\nUpdated system prompt section "tools":\n\n<tools>\n- t${n}\n</tools>`;
		const kept =
			'\n\nUpdated system prompt section "skills":\n\n<skills>\nk\n</skills>';
		const system =
			f.system +
			Array.from({ length: 50_000 }, (_, i) => update(i)).join("") +
			kept;
		const t0 = performance.now();
		const outcome = decide(system);
		const elapsed = performance.now() - t0;
		expect(appendOf(outcome)).toBe(`${expectedTail(f)}${kept}`);
		expect(outcome.detail).toMatchObject({ removedUpdates: 50_000 });
		expect(elapsed).toBeLessThan(1_000);
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
		for (const f of loadPiPromptFixtures("0.87")) {
			if (f.expect.outcome !== "refused") continue;
			const refused = refusalOf(decide(f.system));
			const recorded = JSON.stringify(refused.detail) + refused.error.message;
			for (const line of f.system.split("\n"))
				if (line.length > 24) expect(recorded).not.toContain(line);
		}
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
