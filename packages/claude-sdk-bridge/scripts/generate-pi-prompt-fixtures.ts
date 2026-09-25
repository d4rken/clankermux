#!/usr/bin/env bun
/**
 * Regenerates the pi system-prompt fixtures the `pi-head-v1` policy is
 * tested against, from an installed pi release's own prompt builder and the
 * pi extensions that rewrite its prompt:
 *
 *   bun packages/claude-sdk-bridge/scripts/generate-pi-prompt-fixtures.ts \
 *     [--pi-home ~/.pi] [--layout 0.87]
 *
 * The installed pi-coding-agent must be a release of the layout it writes.
 * Its absolute install path appears in pi's docs section; it is replaced by
 * {@link DOCS_ROOT} so the fixtures do not depend on where pi is installed.
 * Each fixture's expected forwarded text is assembled from pi's own sections
 * and update rendering, never from the policy under test.
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
/** pi's harness head, taken off before anything reaches Claude Code. */
const HEAD_SECTIONS = ["tools", "rules", "docs"];

type Sections = Record<string, string>;
type Patch = Record<string, string | null>;

interface SystemPromptModule {
	buildSystemPromptSections(input: Record<string, unknown>): Sections;
	buildSystemPrompt(input: Record<string, unknown>): string;
	diffSystemPromptSections(
		previous: Sections,
		current: Sections,
	): Patch | undefined;
}

interface TextModule {
	getSystemMessageText(message: Record<string, unknown>): string;
	renderSystemMessageUpdate(message: Record<string, unknown>): string;
}

interface TranscriptModule {
	collapseSystemMessages(context: { messages: unknown[] }): {
		messages: Array<{ sections?: Sections }>;
	};
}

interface ClaudeContextModule {
	composeSystemPromptSupplement(result: {
		catalog: unknown[];
		alwaysOn: unknown[];
	}): string;
}

interface AdvertisedAgentsModule {
	buildAdvertisedAgentPrompt(agents: unknown[]): string | undefined;
	appendAdvertisedAgentPrompt(
		systemPrompt: string,
		advertisedPrompt: string | undefined,
	): string;
}

/** What the policy must make of a fixture. */
type Expectation =
	| {
			outcome: "forwarded";
			headStripped: boolean;
			/** The exact append; null when nothing is left. */
			forwarded: string | null;
			removedUpdates: number;
	  }
	| {
			outcome: "refused";
			code: string;
			reason: string;
			section: string | null;
	  };

type Expected =
	| { outcome: "forwarded" }
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
	/**
	 * How pi sends that update. Its clankermux provider (openai-responses, no
	 * `compat`) collapses every system message into one leading message;
	 * `mid-conversation` is the shape of a model with
	 * `supportsMidConvoSystemMessages`, where the update stays a message of its own.
	 */
	transport?: "collapsed" | "mid-conversation";
	/** An extension's `before_agent_start` rewrite, which pi sends as a forced prompt. */
	force?: (rendered: string) => string;
	expect: Expected;
}

const { values } = parseArgs({
	options: {
		"pi-home": {
			type: "string",
			default: process.env.PI_HOME ?? join(homedir(), ".pi"),
		},
		layout: { type: "string", default: "0.87" },
	},
});
const piHome = resolve(values["pi-home"] as string);
const layout = values.layout as string;
const piRoot = join(piHome, "node_modules/@earendil-works");
const agentDir = join(piRoot, "pi-coding-agent");
const aiDir = join(piRoot, "pi-ai");
const CLAUDE_CONTEXT = join(piHome, "packages/claude-context/core.mjs");
const ADVERTISED_AGENTS = join(
	piHome,
	"agent/git/github.com/d4rken/pi-subagents/src/agents/advertised-agent-prompt.ts",
);

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

const sha256 = (path: string) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");
const GRAMMAR_FILES = [
	"pi-coding-agent/package.json",
	"pi-coding-agent/dist/core/system-prompt.js",
	"pi-coding-agent/dist/core/skills.js",
	"pi-ai/package.json",
	"pi-ai/dist/utils/text.js",
	"pi-ai/dist/utils/transcript.js",
];
const fileHashes = Object.fromEntries(
	GRAMMAR_FILES.map((file) => [file, sha256(join(piRoot, file))]),
);

const prompt = (await import(
	join(agentDir, "dist/core/system-prompt.js")
)) as SystemPromptModule;
const text = (await import(join(aiDir, "dist/utils/text.js"))) as TextModule;
const transcript = (await import(
	join(aiDir, "dist/utils/transcript.js")
)) as TranscriptModule;
const claudeContext = (await import(CLAUDE_CONTEXT)) as ClaudeContextModule;
const advertisedAgents = (await import(
	ADVERTISED_AGENTS
)) as AdvertisedAgentsModule;

const CWD = "/home/user/projects/widget";
const TOOL_SNIPPETS = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make precise file edits with exact text replacement",
	write: "Create or overwrite files",
};
const BASE = { cwd: CWD, toolSnippets: TOOL_SNIPPETS };
const STOCK_PREAMBLE = prompt.buildSystemPromptSections(BASE).preamble ?? "";
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
const DEPLOY_SKILL = {
	name: "deploy",
	description: "Deploy the widget.",
	filePath: "/home/user/.pi/agent/skills/deploy/SKILL.md",
	baseDir: "/home/user/.pi/agent/skills/deploy",
	disableModelInvocation: false,
};
/** pi-subagents' replace-mode prompt shape (child-launch.ts): the agent tag, then its persona. */
const PERSONA = `<active_agent name="reviewer"/>

You are the reviewer agent. Review the diff you are given and report defects.

<rules>
- Report only defects you can point at in the diff.
- Never edit files.
</rules>

<example>
Finding: off-by-one in \`slice(0, n - 1)\`.
</example>`;

/** What claude-context's `before_agent_start` returns (install.mjs): pi's prompt plus its supplement. */
function withClaudeContext(rendered: string): string {
	const supplement = claudeContext.composeSystemPromptSupplement({
		catalog: [
			{
				path: `${CWD}/.claude/rules/api.md`,
				ownerDir: CWD,
				scope: "project",
				paths: ["src/api/**"],
				hash: "a".repeat(64),
			},
		],
		alwaysOn: [
			{
				path: `${CWD}/CLAUDE.md`,
				ownerDir: CWD,
				scope: "project",
				hash: "b".repeat(64),
				content:
					"# Widget for Claude\n\n<important>\nKeep the public API stable.\n</important>",
			},
		],
	});
	return `${rendered}\n\n${supplement}`;
}

/** What pi-subagents' `before_agent_start` returns while the subagent tool is active (extension/index.ts). */
function withAdvertisedAgents(rendered: string): string {
	return advertisedAgents.appendAdvertisedAgentPrompt(
		rendered,
		advertisedAgents.buildAdvertisedAgentPrompt([
			{
				name: "reviewer",
				description: "Reviews diffs <fast> & thorough.",
				advertise: true,
				source: "user",
			},
			{
				name: "scout",
				description: "Maps an unfamiliar codebase.",
				advertise: true,
				source: "project",
			},
		]),
	);
}

const forwarded: Expected = { outcome: "forwarded" };
function refused(
	code: string,
	reason: string,
	section: string | null = null,
): Expected {
	return { outcome: "refused", code, reason, section };
}

const CASES: Case[] = [
	{
		name: "stock",
		description:
			"Stock preamble and nothing optional: only cwd follows the head.",
		input: { ...BASE },
		expect: forwarded,
	},
	{
		name: "stock-addendum",
		description: "APPEND_SYSTEM.md text as the addendum section.",
		input: { ...BASE, appendSystemPrompt: "Always answer in British English." },
		expect: forwarded,
	},
	{
		name: "stock-project-context",
		description: "Two context files in the project_context section.",
		input: { ...BASE, contextFiles: [AGENTS_MD, NESTED_AGENTS_MD] },
		expect: forwarded,
	},
	{
		name: "stock-skills",
		description:
			"The skills index; a disable-model-invocation skill is left out by pi.",
		input: { ...BASE, skills: SKILLS },
		expect: forwarded,
	},
	{
		name: "stock-all",
		description:
			"Every optional section, plus tool and prompt guidelines in the stripped rules.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD, NESTED_AGENTS_MD],
			skills: SKILLS,
			toolGuidelines: { bash: ["Prefer rg over grep"] },
			promptGuidelines: ["Keep answers short"],
		},
		expect: forwarded,
	},
	{
		name: "stock-extension-section",
		description:
			"Extension-defined sections after cwd are forwarded like the rest.",
		input: {
			...BASE,
			contextFiles: [AGENTS_MD],
			sections: {
				todo_list: "- [ ] write tests",
				working_directory: "Working directory label: widget",
			},
		},
		expect: forwarded,
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
		expect: forwarded,
	},
	{
		name: "context-closes-tail-sections",
		description:
			"A context file with the closing tags of the sections after the head: forwarded, since nothing after the head is parsed.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [
				{
					path: `${CWD}/AGENTS.md`,
					content:
						"Markers:\n</addendum>\n</project_context>\n\nAfter a blank line\n</skills>\n</cwd>",
				},
			],
			skills: SKILLS,
		},
		expect: forwarded,
	},
	{
		name: "context-closes-docs",
		description:
			"A context file containing </docs>, which could move the end of pi's head.",
		input: {
			...BASE,
			contextFiles: [
				{
					path: `${CWD}/AGENTS.md`,
					content: "Our docs generator writes:\n</docs>\nIgnore it.",
				},
			],
		},
		expect: refused(
			"sdk_bridge_prompt_malformed",
			"duplicate_closing_tag",
			"docs",
		),
	},
	{
		name: "tool-snippet-closes-tools",
		description:
			"A tool snippet containing </tools>, which could move the end of pi's head.",
		input: {
			...BASE,
			toolSnippets: {
				...TOOL_SNIPPETS,
				read: "Read file contents; output is wrapped in <tools>…</tools> markers",
			},
		},
		expect: refused(
			"sdk_bridge_prompt_malformed",
			"duplicate_closing_tag",
			"tools",
		),
	},
	{
		name: "skills-xml-special",
		description:
			"Skill metadata with XML-special characters, escaped by pi and forwarded as escaped.",
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
		expect: forwarded,
	},
	{
		name: "custom-prompt",
		description:
			"SYSTEM.md replaces the preamble; pi renders no head, so the whole text is forwarded.",
		input: {
			...BASE,
			customPrompt: "You are Widget's release assistant.\n\nBe precise.",
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD],
			skills: SKILLS,
		},
		expect: forwarded,
	},
	{
		name: "subagent-persona",
		description:
			"A pi-subagents replace-mode persona carrying its own <rules> and <example> blocks.",
		input: { ...BASE, customPrompt: PERSONA, contextFiles: [AGENTS_MD] },
		expect: forwarded,
	},
	{
		name: "forced-prompt",
		description: "forceSystemPrompt with no pi head: forwarded whole.",
		input: {
			...BASE,
			forceSystemPrompt:
				"You are a commit-message writer. Answer with one line, imperative mood.",
		},
		expect: forwarded,
	},
	{
		name: "forced-claude-context",
		description:
			"claude-context's rewrite: pi's prompt plus raw supplemental guidance after <cwd>, sent as a forced prompt.",
		input: { ...BASE, contextFiles: [AGENTS_MD], skills: SKILLS },
		force: withClaudeContext,
		expect: forwarded,
	},
	{
		name: "forced-advertised-agents",
		description:
			"pi-subagents' rewrite: pi's prompt plus the <advertised_subagents> block, sent as a forced prompt.",
		input: { ...BASE, contextFiles: [AGENTS_MD] },
		force: withAdvertisedAgents,
		expect: forwarded,
	},
	{
		name: "forced-claude-context-and-agents",
		description:
			"Both rewrites in pi's handler order: claude-context first, then pi-subagents on its result.",
		input: { ...BASE, contextFiles: [AGENTS_MD], skills: SKILLS },
		force: (rendered) => withAdvertisedAgents(withClaudeContext(rendered)),
		expect: forwarded,
	},
	{
		name: "collapsed-tools-change",
		description:
			"What pi sends after a tool snippet changes mid-session: one leading message whose tools section changed in place. The head is still first and is stripped.",
		input: { ...BASE, contextFiles: [AGENTS_MD] },
		next: {
			...BASE,
			contextFiles: [AGENTS_MD],
			toolSnippets: {
				...TOOL_SNIPPETS,
				read: "Read file contents (images too)",
			},
		},
		expect: forwarded,
	},
	{
		name: "collapsed-section-update",
		description:
			"What pi sends after skills and context change, the addendum goes and an extension section arrives mid-session: one leading message, forwarded after the head.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD],
			skills: SKILLS.slice(0, 1),
		},
		next: {
			...BASE,
			contextFiles: [AGENTS_MD, NESTED_AGENTS_MD],
			skills: [...SKILLS.slice(0, 1), DEPLOY_SKILL],
			sections: { todo_list: "- [ ] deploy" },
		},
		expect: forwarded,
	},
	{
		name: "collapsed-extension-section-update",
		description:
			"What pi sends after an extension section changes mid-session: one leading message, forwarded.",
		input: { ...BASE, sections: { claude_context: "Guidance v1" } },
		next: { ...BASE, sections: { claude_context: "Guidance v2" } },
		expect: forwarded,
	},
	{
		name: "collapsed-custom-to-stock-refused",
		description:
			"A session whose replaced preamble goes back to stock: pi's collapse keeps the preamble's place but appends tools, rules and docs at the end, so the stock preamble is not followed by its head. Refused under pi-head-v1; the pi side is being asked about it.",
		input: { ...BASE, customPrompt: "You are Widget's release assistant." },
		next: { ...BASE },
		expect: refused("sdk_bridge_prompt_malformed", "incomplete_head"),
	},
	{
		name: "midconvo-update-tools",
		description:
			"Mid-conversation messages: a later turn changes a tool snippet; pi's update to the tools section is removed.",
		input: { ...BASE, contextFiles: [AGENTS_MD] },
		next: {
			...BASE,
			contextFiles: [AGENTS_MD],
			toolSnippets: {
				...TOOL_SNIPPETS,
				read: "Read file contents (images too)",
			},
		},
		transport: "mid-conversation",
		expect: forwarded,
	},
	{
		name: "midconvo-update-extension-section",
		description:
			"Mid-conversation messages: a later turn changes an extension section; the update is forwarded.",
		input: { ...BASE, sections: { claude_context: "Guidance v1" } },
		next: { ...BASE, sections: { claude_context: "Guidance v2" } },
		transport: "mid-conversation",
		expect: forwarded,
	},
	{
		name: "midconvo-update-tools-and-skills",
		description:
			"Mid-conversation messages: one update changing tools and skills; the tools part goes, the skills part stays.",
		input: { ...BASE, skills: SKILLS.slice(0, 1) },
		next: {
			...BASE,
			skills: [...SKILLS.slice(0, 1), DEPLOY_SKILL],
			toolSnippets: { ...TOOL_SNIPPETS, bash: "Execute bash commands" },
		},
		transport: "mid-conversation",
		expect: forwarded,
	},
	{
		name: "midconvo-update-preamble-to-stock",
		description:
			"Mid-conversation messages: the replaced preamble goes back to stock; that update and the head sections it adds are removed.",
		input: { ...BASE, customPrompt: "You are Widget's release assistant." },
		next: { ...BASE },
		transport: "mid-conversation",
		expect: forwarded,
	},
	{
		name: "midconvo-section-update",
		description:
			"Mid-conversation messages: skills and context change, the addendum goes and an extension section arrives; every update is forwarded.",
		input: {
			...BASE,
			appendSystemPrompt: "Always answer in British English.",
			contextFiles: [AGENTS_MD],
			skills: SKILLS.slice(0, 1),
		},
		next: {
			...BASE,
			contextFiles: [AGENTS_MD, NESTED_AGENTS_MD],
			skills: [...SKILLS.slice(0, 1), DEPLOY_SKILL],
			sections: { todo_list: "- [ ] deploy" },
		},
		transport: "mid-conversation",
		expect: forwarded,
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
		expect: refused("sdk_bridge_prompt_refused", "trigger_preamble"),
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
		expect: refused("sdk_bridge_prompt_refused", "trigger_docs_pair"),
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
		expect: refused("sdk_bridge_prompt_refused", "trigger_preamble"),
	},
];

const portable = (value: string): string =>
	value.replaceAll(agentDir, DOCS_ROOT);
const portableSections = (sections: Sections): Sections =>
	Object.fromEntries(
		Object.entries(sections).map(([name, value]) => [name, portable(value)]),
	);

const isStock = (sections: Sections) => sections.preamble === STOCK_PREAMBLE;
const headOf = (sections: Sections) =>
	["preamble", ...HEAD_SECTIONS].map((name) => sections[name]).join("\n\n");

/** The leading message without pi's head, from pi's own sections. */
function tailOf(sections: Sections): string {
	if (!isStock(sections))
		return text.getSystemMessageText({ role: "system", content: "", sections });
	const rest = Object.fromEntries(
		Object.entries(sections).filter(
			([name]) => name !== "preamble" && !HEAD_SECTIONS.includes(name),
		),
	);
	return Object.values(rest).join("\n\n");
}

/** An update message without its head parts, rendered by pi; null when nothing is left. */
function updateWithoutHead(patch: Patch): {
	text: string | null;
	removed: number;
} {
	const kept: Patch = {};
	let removed = 0;
	for (const [name, value] of Object.entries(patch)) {
		if (
			(HEAD_SECTIONS.includes(name) && value !== null) ||
			(name === "preamble" && value === STOCK_PREAMBLE)
		)
			removed++;
		else kept[name] = value;
	}
	return {
		text: Object.keys(kept).length
			? text.renderSystemMessageUpdate({
					role: "system",
					content: "",
					sections: kept,
				})
			: null,
		removed,
	};
}

function render(c: Case) {
	const leading = prompt.buildSystemPromptSections(c.input);
	if (c.input.forceSystemPrompt !== undefined || c.force) {
		const rendered = prompt.buildSystemPrompt(c.input);
		const system = c.force ? c.force(rendered) : rendered;
		const head =
			c.input.forceSystemPrompt === undefined ? headOf(leading) : null;
		const stripped =
			head !== null && isStock(leading) && system.startsWith(`${head}\n\n`);
		const after = stripped ? system.slice((head as string).length + 2) : system;
		return {
			system: portable(system),
			messages: [portable(system)],
			sections: null,
			expected: { headStripped: stripped, forwarded: after, removedUpdates: 0 },
		};
	}
	const first = text.getSystemMessageText({
		role: "system",
		content: "",
		sections: leading,
		timestamp: 0,
	});
	if (first !== prompt.buildSystemPrompt(c.input))
		throw new Error(`${c.name}: pi renders its prompt differently`);
	const next = c.next ? prompt.buildSystemPromptSections(c.next) : null;
	const patch = next ? prompt.diffSystemPromptSections(leading, next) : null;
	if (next && !patch)
		throw new Error(`${c.name}: the next turn changes nothing`);
	const updateMessage = patch
		? { role: "system", content: "", sections: patch, timestamp: 2 }
		: null;
	if (c.transport === "mid-conversation") {
		const messages = [first];
		const parts = [tailOf(leading)];
		let removedUpdates = 0;
		if (updateMessage && patch) {
			messages.push(text.renderSystemMessageUpdate(updateMessage));
			const update = updateWithoutHead(patch);
			if (update.text !== null) parts.push(update.text);
			removedUpdates += update.removed;
		}
		return {
			// The Responses and Chat adapters join instruction messages this way.
			system: portable(messages.join("\n\n")),
			messages: messages.map(portable),
			sections: portableSections(next ?? leading),
			expected: {
				headStripped: isStock(leading),
				forwarded: parts.filter(Boolean).join("\n\n"),
				removedUpdates,
			},
		};
	}
	// pi-ai's resolveTranscript for a model without mid-conversation system
	// messages: every system message replayed into one leading message.
	const [collapsed] = transcript.collapseSystemMessages({
		messages: [
			{ role: "system", content: "", sections: leading, timestamp: 0 },
			{ role: "user", content: "hello", timestamp: 1 },
			...(updateMessage
				? [updateMessage, { role: "user", content: "again", timestamp: 3 }]
				: []),
		],
	}).messages;
	const sections = collapsed?.sections ?? {};
	const system = text.getSystemMessageText({ ...collapsed });
	const names = Object.keys(sections);
	const headFirst =
		isStock(sections) &&
		HEAD_SECTIONS.every((name, i) => names[i + 1] === name);
	if (isStock(sections) && !headFirst && c.expect.outcome !== "refused")
		throw new Error(
			`${c.name}: the stock preamble is not followed by its head`,
		);
	return {
		system: portable(system),
		messages: [portable(system)],
		sections: portableSections(sections),
		expected: {
			headStripped: headFirst,
			forwarded: headFirst ? tailOf(sections) : system,
			removedUpdates: 0,
		},
	};
}

function fixture(c: Case) {
	const { expected, ...rendered } = render(c);
	const expect: Expectation =
		c.expect.outcome === "refused"
			? c.expect
			: {
					outcome: "forwarded",
					headStripped: expected.headStripped,
					forwarded: expected.forwarded ? portable(expected.forwarded) : null,
					removedUpdates: expected.removedUpdates,
				};
	return {
		name: c.name,
		description: c.description,
		input: c.input,
		...(c.next ? { next: c.next } : {}),
		transport: c.transport ?? "collapsed",
		...rendered,
		expect,
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
		`${JSON.stringify(fixture(c), null, "\t")}\n`,
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
			extensionFiles: {
				"packages/claude-context/core.mjs": sha256(CLAUDE_CONTEXT),
				"pi-subagents/src/agents/advertised-agent-prompt.ts":
					sha256(ADVERTISED_AGENTS),
			},
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
	{ cwd: join(import.meta.dir, "../../.."), stdout: "ignore" },
);
if (formatted.exitCode !== 0) {
	console.error(`biome format failed on ${outDir}`);
	process.exit(1);
}
console.log(`${CASES.length} fixtures for pi ${piVersion} in ${outDir}`);
