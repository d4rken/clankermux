import type { ModelDialect } from "@clankermux/types";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "../CopyButton";

/**
 * The origin this dashboard was reached on.
 *
 * The wire mounts and the dashboard are the same server, so whatever host the
 * browser used to load this page is a base URL a client can use too. That is
 * the reason for reading it live rather than printing a constant: behind the
 * Caddy front the operator reaches :8080 while the server itself listens on
 * :8090, and a hardcoded either-one is wrong for half the readers.
 *
 * Falls back to the documented default under `renderToStaticMarkup`, which has
 * no `window`.
 */
function dashboardOrigin(): string {
	return typeof window === "undefined"
		? "http://localhost:8080"
		: window.location.origin;
}

interface DialectSetup {
	/** The one-line ask, visible while the note is collapsed. */
	summary: string;
	/** Where the snippet goes, so a config file is not mistaken for a command. */
	snippetLabel: string;
	snippet: string;
	/** What still bites after the snippet is in place. */
	caveats: ReactNode[];
}

function anthropicSetup(origin: string): DialectSetup {
	return {
		summary:
			"Claude Code ignores this list unless gateway model discovery is " +
			"switched on",
		snippetLabel: "Shell environment",
		snippet: [
			`export ANTHROPIC_BASE_URL=${origin}/wire/anthropic`,
			"export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1",
		].join("\n"),
		caveats: [
			<>
				Both are required, and the base URL has to be this proxy: discovery is
				off by definition when Claude Code talks to{" "}
				<code className="font-mono">api.anthropic.com</code> directly, and
				Bedrock and Vertex setups never read the list at all.
			</>,
			<>
				The list is fetched at startup and cached in{" "}
				<code className="font-mono">~/.claude/cache/gateway-models.json</code>,
				keyed by base URL. An edit here reaches the next Claude Code session,
				not a running one.
			</>,
			<>
				Claude Code keeps only ids containing{" "}
				<code className="font-mono">claude</code> or{" "}
				<code className="font-mono">anthropic</code>, case-insensitively, and
				discards a reply left empty by that filter. A custom entry named outside
				the pattern is still served, just never shown in its picker.
			</>,
			<>
				The same two can be set as JSON string values in the{" "}
				<code className="font-mono">env</code> object of{" "}
				<code className="font-mono">~/.claude/settings.json</code> instead of
				exported — the snippet above is shell syntax, not JSON.
			</>,
		],
	};
}

function openaiSetup(origin: string): DialectSetup {
	return {
		summary:
			"The Codex CLI reads this list with no flag to set, once its provider " +
			"points at this mount",
		snippetLabel: "~/.codex/config.toml",
		snippet: [
			'model_provider = "clankermux"',
			"",
			"[model_providers.clankermux]",
			`base_url = "${origin}/wire/openai/v1"`,
			'wire_api = "responses"',
			'env_key = "CLANKERMUX_API_KEY"',
		].join("\n"),
		caveats: [
			<>
				Curation only reaches Codex while the requesting key's routing scope
				admits an unpaused Codex account, since the catalogue Codex parses is
				read from a live subscription — a pin that excludes every Codex account
				leaves none to read. With none, the mount answers in the plain OpenAI
				list shape, which Codex cannot deserialize, and it falls back to the
				catalogue built into its own binary without saying so.
			</>,
			<>
				Codex caches what it read in{" "}
				<code className="font-mono">~/.codex/models_cache.json</code>. An edit
				here shows up once that cache is refreshed; restart Codex, and delete
				the file if it looks stuck.
			</>,
			<>
				<code className="font-mono">env_key</code> names an environment variable
				rather than holding the key, so Codex also needs{" "}
				<code className="font-mono">CLANKERMUX_API_KEY</code> exported. Any
				value will do while this proxy runs open; otherwise use a key from the
				API Keys page.
			</>,
			<>
				Other OpenAI-format clients read the same URL, and need the base URL and
				— on a protected deployment — a key, nothing more.
			</>,
		],
	};
}

/**
 * What the operator still has to do on the CLIENT for this curation to matter.
 *
 * The page edits a list; it cannot make anything read it. Neither CLI complains
 * when it is not configured to — Claude Code simply skips the fetch, and Codex
 * quietly uses its built-in catalogue — so an operator who hides a model and
 * sees no change has nothing on screen to explain why. This is that
 * explanation, sitting next to the edit that provokes the question.
 *
 * Collapsed by default, and a native `<details>` rather than state plus a
 * button: it is reference material read once per setup, and the native element
 * is keyboard operable and announced correctly with no work.
 */
export function ClientSetupNote({ dialect }: { dialect: ModelDialect }) {
	const origin = dashboardOrigin();
	const setup =
		dialect === "anthropic" ? anthropicSetup(origin) : openaiSetup(origin);
	return (
		// Its own top margin: CardHeader is a bare `flex flex-col` with no gap, so
		// without this the note would sit flush against the blurb above it.
		<details className="group mt-tight max-w-prose">
			{/* `list-none` plus the webkit marker rule drop the default disclosure
			    triangle in every engine; the chevron replaces it at the end of the
			    sentence, where the eye already is. */}
			<summary className="flex cursor-pointer list-none items-start gap-tight text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<span className="min-w-0">{setup.summary}</span>
				<ChevronDown className="mt-0.5 h-3 w-3 shrink-0 transition-transform duration-200 group-open:rotate-180" />
			</summary>

			<div className="mt-tight space-y-tight border-l border-border pl-item">
				<div className="flex items-center justify-between gap-tight">
					<span className="text-xs text-muted-foreground">
						{setup.snippetLabel}
					</span>
					<CopyButton value={setup.snippet} title="Copy the snippet" />
				</div>
				<pre className="overflow-x-auto rounded-lg bg-muted p-item font-mono text-xs">
					{setup.snippet}
				</pre>
				<ul className="space-y-tight text-xs text-muted-foreground">
					{setup.caveats.map((caveat, index) => (
						// Static prose in a fixed order: the index IS the identity, and
						// there is no other stable key a ReactNode could offer.
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-order literals
						<li key={index}>{caveat}</li>
					))}
				</ul>
			</div>
		</details>
	);
}
