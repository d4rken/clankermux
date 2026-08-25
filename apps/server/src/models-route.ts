import { Logger } from "@clankermux/logger";
import type { AnthropicModelCatalogSnapshot } from "@clankermux/proxy";
import { ANTHROPIC_BUNDLED_MODEL_CREATED_AT } from "@clankermux/proxy";
import {
	applyOverrides,
	indexOverrides,
	type ModelOverride,
	type NamedModel,
} from "./model-overrides";
import type { WireDialect } from "./wire-mounts";

const log = new Logger("ModelsRoute");

/**
 * The parameter that tells the two OpenAI-dialect clients apart.
 *
 * Codex's models-manager sends it on every fetch; OpenAI-format clients
 * (opencode, ohmypi) do not send it at all. Only its PRESENCE is read.
 *
 * Its VALUE is deliberately ignored. An earlier revision forwarded it upstream,
 * which was wrong twice over: it would have asked OpenAI for a catalog at a
 * version this proxy does not speak (see CODEX_MODEL_CATALOG_URL), and it made
 * a client-controlled string into a cache key, where varying it would mint an
 * unbounded number of misses — each one a fresh authenticated call to
 * chatgpt.com on a real account's OAuth bearer. Reading presence only removes
 * both problems at the source rather than validating the value.
 */
const CLIENT_VERSION_PARAM = "client_version";

/**
 * Ceiling on the override read, and the reason this route can still promise a
 * 200 while depending on the database.
 *
 * The SQLite adapter's busy-retry can persist for minutes. A curation read is a
 * nicety — the upstream catalogue is the answer, the overrides only adjust it —
 * so a slow database degrades to "serve the uncurated list" rather than holding
 * a Claude Code or Codex startup for as long as the lock lasts.
 */
const OVERRIDE_READ_BUDGET_MS = 2_000;

export interface CodexModelCatalogBody {
	bodyText: string;
	etag: string | null;
}

export interface ModelsRouteDeps {
	/**
	 * The Codex catalog this API key may be shown, or null when the pool cannot
	 * read one. Takes the key because entitlement is per-subscription and a
	 * pinned key must not be shown a catalog from outside its pin.
	 */
	getCatalog(apiKeyId: string | null): Promise<CodexModelCatalogBody | null>;
	/** The OpenAI Models-list reply for `ids`, in the shape that package owns. */
	staticModels(ids: readonly string[]): Response;
	/** The bundled Codex model ids the OpenAI list is built from. */
	staticModelIds: readonly string[];
	/** Anthropic's own listing: live when we could read it, bundled otherwise. */
	getAnthropicCatalog(): Promise<AnthropicModelCatalogSnapshot>;
	/** The operator's curation for one dialect. */
	listOverrides(dialect: WireDialect): Promise<readonly ModelOverride[]>;
}

/**
 * Answer `GET /v1/models` in whichever shape the caller actually parses.
 *
 * THREE shapes, picked by the mount and then by the query string:
 *
 *  - `/wire/anthropic` gets Anthropic's own `{"data":[{"type":"model",…}]}`
 *    listing. Claude Code's gateway model discovery reads exactly this.
 *  - `/wire/openai` with `client_version` gets the Codex `{"models":[…]}`
 *    catalog, because Codex, handed OpenAI's list shape instead, fails to
 *    deserialize it, logs `failed to load models cache`, and silently falls
 *    back to the catalog built into its own binary. That silence is why this
 *    route looked healthy while being useless to its only caller.
 *  - `/wire/openai` without it gets OpenAI's `{"object":"list","data":[…]}`.
 *
 * Every failure path still answers 200. A client startup must never be blocked
 * by our inability to read a catalogue; it should just land back on the
 * behaviour it had before.
 */
export async function handleModelsRoute(
	url: URL,
	deps: ModelsRouteDeps,
	apiKeyId: string | null,
	dialect: WireDialect,
): Promise<Response> {
	const overrides = await readOverrides(deps, dialect);

	if (dialect === "anthropic") {
		return await serveAnthropicModels(deps, overrides);
	}

	if (!url.searchParams.has(CLIENT_VERSION_PARAM)) {
		// The OpenAI list shape has no display-name field, so a rename cannot
		// materialise here — hides and additions do, and the rename still shows in
		// the dashboard and in the two shapes that carry a name.
		const ids = applyOverrides(
			deps.staticModelIds.map(toNamedModel),
			overrides,
			(override) => toNamedModel(override.modelId),
		).map((entry) => entry.id);
		return deps.staticModels(ids);
	}

	let catalog: CodexModelCatalogBody | null = null;
	try {
		catalog = await deps.getCatalog(apiKeyId);
	} catch (error) {
		// Defensive: the cache is written to swallow its own failures, so reaching
		// here means something unforeseen. Still not a reason to fail the request.
		log.warn(
			"Model-catalog lookup threw; serving the static list instead:",
			error instanceof Error ? error.message : String(error),
		);
	}

	if (!catalog) {
		// Acknowledged limitation: this is the OpenAI list shape, NOT the Codex
		// catalog envelope, so the Codex CLI ignores it and uses its built-in
		// catalog — exactly as it did before this route existed. Curation applied
		// on this path therefore reaches generic OpenAI clients only. Serving a
		// hand-built catalog envelope instead would mean inventing the ~34 fields
		// per entry Codex requires, including each model's own base instructions.
		const ids = applyOverrides(
			deps.staticModelIds.map(toNamedModel),
			overrides,
			(override) => toNamedModel(override.modelId),
		).map((entry) => entry.id);
		return deps.staticModels(ids);
	}

	if (overrides.length === 0) {
		// The uncurated path, byte for byte what shipped before overrides existed:
		// the upstream body verbatim and its own validator. We do not honour
		// inbound If-None-Match; no observed client sends one, and a wrong 304 is
		// harder to diagnose than a plain 200.
		const headers = new Headers({ "Content-Type": "application/json" });
		if (catalog.etag) headers.set("ETag", catalog.etag);
		return new Response(catalog.bodyText, { status: 200, headers });
	}

	const curated = applyOverridesToCodexCatalog(catalog.bodyText, overrides);
	if (curated === null) {
		// A catalog we cannot parse is still a catalog Codex can: serve it
		// unmodified rather than breaking the CLI over our own curation.
		log.warn(
			"Could not apply model overrides to the Codex catalog; serving it unmodified",
		);
		const headers = new Headers({ "Content-Type": "application/json" });
		if (catalog.etag) headers.set("ETag", catalog.etag);
		return new Response(catalog.bodyText, { status: 200, headers });
	}

	// No ETag: the body is ours now, not upstream's, and reusing upstream's
	// validator would let a client cache the curated body under a tag that
	// changes only when UPSTREAM changes — so an edit here would go unseen.
	return new Response(curated, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * The curation for `dialect`, or none.
 *
 * Guarded twice over, because this route's 200 must not depend on the database
 * being responsive: a rejection is caught, and a read that never settles is
 * abandoned at {@link OVERRIDE_READ_BUDGET_MS}. Both degrade to "no overrides",
 * which is the uncurated behaviour rather than an error.
 */
async function readOverrides(
	deps: ModelsRouteDeps,
	dialect: WireDialect,
): Promise<readonly ModelOverride[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<readonly ModelOverride[]>((resolve) => {
		timer = setTimeout(() => {
			log.warn(
				"Model-override read exceeded its budget; serving the uncurated catalogue",
			);
			resolve([]);
		}, OVERRIDE_READ_BUDGET_MS);
		// Never hold the process open for a catalogue read.
		(timer as { unref?: () => void }).unref?.();
	});

	// Neutralised here rather than around the race: once the deadline wins,
	// nothing awaits the read, and a late rejection would surface as an unhandled
	// one with no caller left to blame.
	const read = (async () => {
		try {
			return await deps.listOverrides(dialect);
		} catch (error) {
			log.warn(
				"Could not read the model overrides; serving the uncurated catalogue:",
				error instanceof Error ? error.message : String(error),
			);
			return [];
		}
	})();

	try {
		return await Promise.race([read, deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** One entry of Anthropic's `GET /v1/models` reply. */
interface AnthropicModelDto {
	type: "model";
	id: string;
	display_name: string;
	created_at: string;
}

/** A baseline entry carrying the creation date Anthropic's shape needs. */
interface DatedModel extends NamedModel {
	createdAt: string;
}

async function serveAnthropicModels(
	deps: ModelsRouteDeps,
	overrides: readonly ModelOverride[],
): Promise<Response> {
	let snapshot: AnthropicModelCatalogSnapshot | null = null;
	try {
		snapshot = await deps.getAnthropicCatalog();
	} catch (error) {
		// Defensive: the cache resolves rather than rejects, so reaching here means
		// something unforeseen. The reply is then built from the curation alone,
		// which still answers 200 — the promise this route makes to every client.
		log.warn(
			"Anthropic model-catalogue lookup threw; serving the curation alone:",
			error instanceof Error ? error.message : String(error),
		);
	}

	const baseline: DatedModel[] = (snapshot?.models ?? []).map((model) => ({
		id: model.id,
		displayName: model.displayName,
		createdAt: model.createdAt,
	}));

	const composed = applyOverrides(baseline, overrides, (override) => ({
		id: override.modelId,
		displayName: override.displayName ?? override.modelId,
		// The stored row keeps epoch ms; the wire shape wants ISO-8601.
		createdAt: isoFromEpochMs(override.createdAt),
	}));

	// Field-by-field validation on the way out, not a cast. These values crossed
	// a cache and a database boundary, and a client that cannot deserialize one
	// entry drops the WHOLE list — silently, in Claude Code's case.
	const data: AnthropicModelDto[] = composed.map((entry) => ({
		type: "model",
		id: entry.id,
		display_name: asString(entry.displayName, entry.id),
		created_at: asString(entry.createdAt, ANTHROPIC_BUNDLED_MODEL_CREATED_AT),
	}));

	// `limit` is accepted and ignored: the whole list is short enough that
	// pagination would be ceremony, and a client asking for fewer entries than
	// exist would then have no way to reach the rest.
	const body = {
		data,
		has_more: false,
		first_id: data.length > 0 ? data[0].id : null,
		last_id: data.length > 0 ? data[data.length - 1].id : null,
	};

	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Re-serialize the Codex catalog with the curation applied, or null when the
 * body is not the envelope we know how to edit.
 *
 * Entries are carried through as objects rather than rebuilt: Codex requires
 * ~18 fields per entry — reasoning levels, context window, the model's own
 * `base_instructions` — and a rebuild that quietly dropped one would look
 * exactly like success from here while the CLI fell back to its built-in
 * catalog. Only `slug` and `display_name` are ever written.
 */
function applyOverridesToCodexCatalog(
	bodyText: string,
	overrides: readonly ModelOverride[],
): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const envelope = parsed as { models?: unknown };
	if (!Array.isArray(envelope.models)) return null;

	const entries = envelope.models.filter(
		(entry): entry is Record<string, unknown> =>
			typeof entry === "object" && entry !== null && !Array.isArray(entry),
	);

	// Chosen from the UNFILTERED list, before any hide is applied, so which entry
	// a custom model is cloned from does not change when an unrelated model is
	// hidden. With no entries at all there is nothing to clone and custom
	// injection is skipped for this response — a hand-built entry would be
	// missing the semantic fields Codex needs and would take the whole catalog
	// down with it.
	const template = entries[0] ?? null;

	const index = indexOverrides(
		entries.map((entry) => readSlug(entry)).filter((slug) => slug !== null),
		overrides,
	);

	const models: unknown[] = [];
	for (const entry of entries) {
		const slug = readSlug(entry);
		if (slug !== null && index.hidden.has(slug)) continue;
		const renamed = slug === null ? undefined : index.displayNames.get(slug);
		models.push(renamed ? { ...entry, display_name: renamed } : entry);
	}
	if (template) {
		for (const addition of index.additions) {
			models.push({
				...structuredClone(template),
				slug: addition.modelId,
				display_name: addition.displayName ?? addition.modelId,
			});
		}
	}

	return JSON.stringify({ ...envelope, models });
}

function readSlug(entry: Record<string, unknown>): string | null {
	return typeof entry.slug === "string" && entry.slug.length > 0
		? entry.slug
		: null;
}

function toNamedModel(id: string): NamedModel {
	return { id, displayName: id };
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

/**
 * Epoch ms to ISO-8601, or the bundled default.
 *
 * `Date.prototype.toISOString` THROWS on an out-of-range timestamp rather than
 * returning "Invalid Date", so a corrupt row would otherwise take the whole
 * reply down instead of costing one entry a plausible date.
 */
function isoFromEpochMs(epochMs: number): string {
	const date = new Date(epochMs);
	if (Number.isNaN(date.getTime())) return ANTHROPIC_BUNDLED_MODEL_CREATED_AT;
	return date.toISOString();
}
