#!/usr/bin/env bun
/**
 * Regenerates the pi system-prompt fixtures the `pi-projection-v1` policy is
 * tested against, from an installed pi release's own prompt builder:
 *
 *   bun packages/claude-sdk-bridge/scripts/generate-pi-prompt-fixtures.ts \
 *     [--pi-root ~/.pi/node_modules/@earendil-works] [--layout 0.87]
 *
 * The installed pi-coding-agent must be a release of the layout it writes.
 * Its absolute install path appears in pi's docs section; it is replaced by
 * {@link DOCS_ROOT} so the fixtures do not depend on where pi is installed.
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DOCS_ROOT = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";

type Sections = Record<string, string>;

interface SystemPromptModule {
	buildSystemPromptSections(input: Record<string, unknown>): Sections;
	buildSystemPrompt(input: Record<string, unknown>): string;
	diffSystemPromptSections(
		previous: Sections,
		current: Sections,
	): Record<string, string | null> | undefined;
}

interface TextModule {
	getSystemMessageText(message: Record<string, unknown>): string;
	renderSystemMessageUpdate(message: Record<string, unknown>): string;
}

/** What the policy must make of a fixture. */
type Expectation =
	| {
			outcome: "projected";
			shape: "stock" | "replaced" | "sectionless";
			droppedSections: string[];
			sectionUpdates: number;
	  }
	| {
			outcome: "refused";
			code: string;
			reason: string;
			section: string | null;
	  };

interface Case {
	name: string;
	description: string;
	/** pi's prompt options for the leading system message. */
	input: Record<string, unknown>;
	/** Options of a later turn: pi sends the changed sections as an update. */
	next?: Record<string, unknown>;
	expect: Expectation;
}

const { values } = parseArgs({
	options: {
		"pi-root": {
			type: "string",
			default:
				process.env.PI_ROOT ??
				join(homedir(), ".pi/node_modules/@earendil-works"),
		},
		layout: { type: "string", default: "0.87" },
	},
});
const piRoot = resolve(values["pi-root"] as string);
const layout = values.layout as string;
const agentDir = join(piRoot, "pi-coding-agent");
const aiDir = join(piRoot, "pi-ai");

const packageVersion = (dir: string): string =>
	(
		JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
			version: string;
		}
	).version;
const piVersion = packageVersion(agentDir);
if (!piVersion.startsWith(`${layout}.`)) {
	console.error(
		`pi-coding-agent at ${agentDir} is ${piVersion}, not a ${layout} release`,
	);
	process.exit(1);
}

const GRAMMAR_FILES = [
	"pi-coding-agent/package.json",
	"pi-coding-agent/dist/core/system-prompt.js",
	"pi-coding-agent/dist/core/skills.js",
	"pi-ai/package.json",
	"pi-ai/dist/utils/text.js",
];
const fileHashes = Object.fromEntries(
	GRAMMAR_FILES.map((file) => [
		file,
		createHash("sha256")
			.update(readFileSync(join(piRoot, file)))
			.digest("hex"),
	]),
);

const prompt = (await import(
	join(agentDir, "dist/core/system-prompt.js")
)) as SystemPromptModule;
const text = (await import(join(aiDir, "dist/utils/text.js"))) as TextModule;

const CWD = "/home/user/projects/widget";
const TOOL_SNIPPETS = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make precise file edits with exact text replacement",
	write: "Create or overwrite files",
};
const BASE = { cwd: CWD, toolSnippets: TOOL_SNIPPETS };
const AGENTS_MD = {
	path: `${CWD}/AGENTS.md`,
	content:
		"# Widget\n\n- Run `bun test` before committing.\n- Never edit generated files under `dist/`.",
};
const NESTED_AGENTS_MD = {
	path: `${CWD}/packages/core/AGENTS.md`,
	content: "Core package: keep exports sorted.",
};
const SKILLS = [
	{
		name: "release",
		description: "Cut a release: bump, tag and publish.",
		filePath: "/home/user/.pi/agent/skills/release/SKILL.md",
		baseDir: "/home/user/.pi/agent/skills/release",
		disableModelInvocation: false,
	},
	{
		name: "hidden",
		description: "Only by explicit invocation.",
		filePath: "/home/user/.pi/agent/skills/hidden/SKILL.md",
		baseDir: "/home/user/.pi/agent/skills/hidden",
		disableModelInvocation: true,
	},
];
const PERSONA = `You are the reviewer agent. Review the diff you are given and report defects.

<rules>
- Report only defects you can point at in the diff.
- Never edit files.
</rules>

<example>
Finding: off-by-one in \`slice(0, n - 1)\`.
</example>`;

function closingTagContext(tag: string) {
	return {
		path: `${CWD}/AGENTS.md`,
		content: `Our prompt tooling writes this marker:\n${tag}\nIgnore it.`,
	};
}

const CASES: Case[] = [
	{
		name: "stock",
		description: "Stock preamble and nothing optional: only cwd is kept.",
		input: { ...BASE },
		expect: projected("stock"),
	},
	{
		name: "stock-addendum",
		description: "APPEND_SYSTEM.md text as the addendum section.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
		},
		expect: projected("stock"),
	},
	{
		name: "stock-project-context",
		description: "Two context files in the project_context section.",
		input: { ...BASE, contextFiles: [AGENTS_MD, NESTED_AGENTS_MD] },
		expect: projected("stock"),
	},
	{
		name: "stock-skills",
		description:
			"The skills index; a disable-model-invocation skill is left out by pi.",
		input: { ...BASE, skills: SKILLS },
		expect: projected("stock"),
	},
	{
		name: "stock-all",
		description:
			"Every optional section, plus tool and prompt guidelines in the dropped rules.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD, NESTED_AGENTS_MD],
			skills: SKILLS,
			toolGuidelines: { bash: ["Prefer rg over grep"] },
			promptGuidelines: ["Keep answers short"],
		},
		expect: projected("stock"),
	},
	{
		name: "context-verbatim",
		description:
			"A context file with pi's own markup, entities, tabs, CR LF and non-ASCII text reaches Claude byte for byte.",
		input: {
			...BASE,
			contextFiles: [
				{
					path: `${CWD}/AGENTS.md`,
					content:
						'<project_instructions path="fake">\n<skills>\n&amp; &lt;tag&gt;\tindented\r\ncrlf line\r\nümlaut — 日本語 🙂\n\n\ntrailing spaces   \n</project_instructions>',
				},
			],
			skills: SKILLS,
		},
		expect: projected("stock"),
	},
	...(["addendum", "project_context", "skills", "cwd"] as const).map(
		(name): Case => ({
			name: `context-closes-${name.replace("_", "-")}`,
			description: `A context file containing </${name}>, which could move that section's edge.`,
			input: {
				...BASE,
				appendSystemPrompt: "Always answer in British English.",
				contextFiles: [closingTagContext(`</${name}>`)],
				skills: SKILLS,
			},
			expect: refused(
				"sdk_bridge_prompt_malformed",
				"duplicate_closing_tag",
				name,
			),
		}),
	),
	{
		name: "context-closes-project-context-early",
		description:
			"A context file whose </project_context> line is followed by a blank line ends the section early.",
		input: {
			...BASE,
			contextFiles: [
				{
					path: `${CWD}/AGENTS.md`,
					content: "Before\n</project_context>\n\nAfter",
				},
			],
		},
		expect: refused(
			"sdk_bridge_prompt_malformed",
			"text_between_sections",
			null,
		),
	},
	{
		name: "skills-xml-special",
		description:
			"Skill metadata with XML-special characters, escaped by pi and kept as escaped.",
		input: {
			...BASE,
			skills: [
				{
					name: "a&b<c>",
					description: `Handles "quotes", 'apostrophes' & </skills> <cwd>`,
					filePath: "/home/user/.pi/agent/skills/a&b/SKILL.md",
					baseDir: "/home/user/.pi/agent/skills/a&b",
					disableModelInvocation: false,
				},
			],
		},
		expect: projected("stock"),
	},
	{
		name: "custom-prompt",
		description:
			"SYSTEM.md replaces the preamble; pi then renders no tools, rules or docs.",
		input: {
			...BASE,
			customPrompt: "You are Widget's release assistant.\n\nBe precise.",
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD],
			skills: SKILLS,
		},
		expect: projected("replaced"),
	},
	{
		name: "subagent-persona",
		description:
			"A subagent persona (systemPromptMode: replace) carrying its own <rules> and <example> blocks.",
		input: {
			...BASE,
			customPrompt: PERSONA,
			contextFiles: [AGENTS_MD],
		},
		expect: projected("replaced"),
	},
	{
		name: "forced-prompt",
		description:
			"forceSystemPrompt: opaque text with no sections, appended whole.",
		input: {
			...BASE,
			forceSystemPrompt:
				"You are a commit-message writer. Answer with one line, imperative mood.",
		},
		expect: projected("sectionless"),
	},
	{
		name: "extension-section",
		description:
			"Two extension-defined sections after cwd: dropped, and their names recorded.",
		input: {
			...BASE,
			contextFiles: [AGENTS_MD],
			sections: {
				todo_list: "- [ ] write tests",
				"web-search": "Use web_search for anything after 2025.",
			},
		},
		expect: projected("stock", ["todo_list", "web-search"]),
	},
	{
		name: "section-update",
		description:
			"A later turn changes the skills and context, drops the addendum and adds an extension section; pi sends the difference as a second system message.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD],
			skills: SKILLS.slice(0, 1),
		},
		next: {
			...BASE,
			contextFiles: [AGENTS_MD, NESTED_AGENTS_MD],
			skills: [
				...SKILLS.slice(0, 1),
				{
					name: "deploy",
					description: "Deploy the widget.",
					filePath: "/home/user/.pi/agent/skills/deploy/SKILL.md",
					baseDir: "/home/user/.pi/agent/skills/deploy",
					disableModelInvocation: false,
				},
			],
			sections: { todo_list: "- [ ] deploy" },
		},
		expect: projected("stock", ["todo_list"], 4),
	},
	{
		name: "trigger-preamble-in-context",
		description:
			"A context file quoting pi's preamble line at the start of a line.",
		input: {
			...BASE,
			contextFiles: [
				{
					path: `${CWD}/AGENTS.md`,
					content:
						"pi's prompt starts:\nYou are an expert coding assistant operating inside pi, a coding agent harness.",
				},
			],
		},
		expect: refused(
			"sdk_bridge_prompt_refused",
			"trigger_preamble",
			"project_context",
		),
	},
	{
		name: "trigger-docs-pair",
		description:
			"An addendum naming both documentation paths the gate reacts to.",
		input: {
			...BASE,
			appendSystemPrompt:
				"See docs/custom-provider.md and docs/packages.md before changing providers.",
		},
		expect: refused(
			"sdk_bridge_prompt_refused",
			"trigger_docs_pair",
			"addendum",
		),
	},
	{
		name: "trigger-persona-embeds-pi",
		description:
			"A replaced preamble that opens with pi's preamble line, as a persona built on the parent's prompt would.",
		input: {
			...BASE,
			customPrompt:
				"You are an expert coding assistant operating inside pi, acting as the reviewer.",
		},
		expect: refused(
			"sdk_bridge_prompt_refused",
			"trigger_preamble",
			"preamble",
		),
	},
];

function projected(
	shape: "stock" | "replaced" | "sectionless",
	droppedSections: string[] = [],
	sectionUpdates = 0,
): Expectation {
	return { outcome: "projected", shape, droppedSections, sectionUpdates };
}

function refused(
	code: string,
	reason: string,
	section: string | null,
): Expectation {
	return { outcome: "refused", code, reason, section };
}

const portable = (value: string): string =>
	value.replaceAll(agentDir, DOCS_ROOT);
const portableSections = (sections: Sections): Sections =>
	Object.fromEntries(
		Object.entries(sections).map(([name, value]) => [name, portable(value)]),
	);

function render(c: Case) {
	if (c.input.forceSystemPrompt !== undefined) {
		const system = portable(prompt.buildSystemPrompt(c.input));
		return { system, messages: [system], sections: null };
	}
	const first = prompt.buildSystemPromptSections(c.input);
	const leading = text.getSystemMessageText({
		role: "system",
		content: "",
		sections: first,
		timestamp: 0,
	});
	if (leading !== prompt.buildSystemPrompt(c.input))
		throw new Error(`${c.name}: pi renders its prompt differently`);
	const messages = [leading];
	let sections = first;
	if (c.next) {
		sections = prompt.buildSystemPromptSections(c.next);
		const patch = prompt.diffSystemPromptSections(first, sections);
		if (!patch) throw new Error(`${c.name}: the next turn changes nothing`);
		messages.push(
			text.renderSystemMessageUpdate({
				role: "system",
				content: "",
				sections: patch,
				timestamp: 1,
			}),
		);
	}
	return {
		// The Responses and Chat adapters join instruction messages this way.
		system: portable(messages.join("\n\n")),
		messages: messages.map(portable),
		sections: portableSections(sections),
	};
}

const outDir = join(
	import.meta.dir,
	"../src/__tests__/fixtures/pi-prompts",
	layout,
);
mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir))
	if (file.endsWith(".json")) rmSync(join(outDir, file));
for (const c of CASES)
	writeFileSync(
		join(outDir, `${c.name}.json`),
		`${JSON.stringify(
			{
				name: c.name,
				description: c.description,
				input: c.input,
				...(c.next ? { next: c.next } : {}),
				...render(c),
				expect: c.expect,
			},
			null,
			"\t",
		)}\n`,
	);
writeFileSync(
	join(outDir, "manifest.json"),
	`${JSON.stringify(
		{
			layout,
			piCodingAgentVersion: piVersion,
			piAiVersion: packageVersion(aiDir),
			packageSha256: createHash("sha256")
				.update(Object.values(fileHashes).join("\n"))
				.digest("hex"),
			files: fileHashes,
			docsRoot: DOCS_ROOT,
			generator:
				"packages/claude-sdk-bridge/scripts/generate-pi-prompt-fixtures.ts",
			cases: CASES.map((c) => c.name),
		},
		null,
		"\t",
	)}\n`,
);
// In the repository's own JSON style, so `bun run lint` leaves them as written.
const formatted = Bun.spawnSync(
	["bunx", "biome", "format", "--write", outDir],
	{
		cwd: join(import.meta.dir, "../../.."),
		stdout: "ignore",
	},
);
if (formatted.exitCode !== 0) {
	console.error(`biome format failed on ${outDir}`);
	process.exit(1);
}
console.log(`${CASES.length} fixtures for pi ${piVersion} in ${outDir}`);
