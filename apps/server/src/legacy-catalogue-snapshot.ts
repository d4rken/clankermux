/**
 * The pre-2026.9.52 global catalogue, rendered once so an upgrading database
 * keeps its curation.
 *
 * MIGRATION ONLY. Nothing serves from here. Every live request answers from the
 * asking client's own saved catalogue, and the only caller of this module is
 * `ClientService.legacyProfile`, which runs once per database behind the
 * `backfill:client-catalogues-v1` marker to seed `client_profiles` for keys that
 * predate per-client catalogues. A database created after that release never
 * reaches this code at all.
 *
 * This file is also the only remaining reader of the `model_overrides` table.
 * The table is retained read-only for exactly that reason: dropping it would
 * silently discard whatever curation an operator had before upgrading, with no
 * way to recover it.
 *
 * It is deliberately self-contained — the composition rules, the row mapping,
 * the read and the three wire shapes all live here rather than being shared
 * with code that still runs — so the cleanup is one step: when the supported
 * upgrade floor moves past 2026.9.52, delete this file, its test, and the
 * `model_overrides` table.
 */

import type {
	ModelOverrideDialect,
	ModelOverrideRow,
} from "@clankermux/database";
import { Logger } from "@clankermux/logger";
import type { AnthropicModelCatalogSnapshot } from "@clankermux/proxy";
import { ANTHROPIC_BUNDLED_MODEL_CREATED_AT } from "@clankermux/proxy";
import type { ClientFormat } from "@clankermux/types";

const log = new Logger("LegacyCatalogue");

/** Bound the curation read so a migration cannot wait on SQLite retries. */
const OVERRIDE_READ_BUDGET_MS = 2_000;

/** One curation row, in the shape the composition helpers take. */
export interface ModelOverride {
	modelId: string;
	/** Remove this baseline entry from the served list. */
	hidden: boolean;
	/** Add this entry; the baseline does not have it. */
	custom: boolean;
	/** Replaces the shown name. Null leaves the baseline's own name. */
	displayName: string | null;
	/** Epoch ms; orders the appended custom entries. */
	createdAt: number;
}

/** The least a baseline entry has to carry to be composable. */
interface NamedModel {
	id: string;
	displayName: string;
}

/** The rich Codex catalogue as the cache hands it over. */
export interface CodexModelCatalogBody {
	bodyText: string;
	etag: string | null;
}

export interface LegacyCatalogueDeps {
	/** The rich Codex catalog, or null when the pool could not read one. */
	getCatalog(): Promise<CodexModelCatalogBody | null>;
	/** The OpenAI Models-list reply for `ids`, in the shape that package owns. */
	staticModels(ids: readonly string[]): Response;
	/** The bundled Codex model ids the OpenAI list is built from. */
	staticModelIds: readonly string[];
	/** Anthropic's own listing: live when we could read it, bundled otherwise. */
	getAnthropicCatalog(): Promise<AnthropicModelCatalogSnapshot>;
	/** The operator's curation for one dialect. */
	listOverrides(
		dialect: ModelOverrideDialect,
	): Promise<readonly ModelOverride[]>;
}

/** The stored curation for one dialect, mapped off the raw rows. */
export async function listLegacyOverrides(
	dbOps: {
		listModelOverrides(
			dialect: ModelOverrideDialect,
		): Promise<ModelOverrideRow[]>;
	},
	dialect: ModelOverrideDialect,
): Promise<ModelOverride[]> {
	const rows = await dbOps.listModelOverrides(dialect);
	return rows.map((row) => ({
		modelId: row.model_id,
		hidden: row.hidden === 1,
		custom: row.custom === 1,
		displayName: row.display_name,
		createdAt: row.created_at,
	}));
}

/**
 * The global catalogue as one client format saw it, with the curation applied.
 *
 * THREE shapes, and none of the three clients can read another's: Claude Code
 * parses Anthropic's `{"data":[{"type":"model",…}]}` listing, Codex parses the
 * `{"models":[…]}` catalog, and generic OpenAI clients parse
 * `{"object":"list","data":[…]}`. The migration copies whichever one the format
 * names, so the seeded profile holds what that client would have been served.
 */
export async function renderLegacyCatalogue(
	format: ClientFormat,
	deps: LegacyCatalogueDeps,
): Promise<Response> {
	const overrides = await readOverrides(
		deps,
		format === "anthropic" ? "anthropic" : "openai",
	);

	if (format === "anthropic") {
		return await serveAnthropicModels(deps, overrides);
	}

	if (format === "openai") {
		// The OpenAI list shape has no display-name field, so a rename cannot
		// materialise here — hides and additions do, and the rename still shows in
		// the shape that carries a name.
		const ids = applyOverrides(
			deps.staticModelIds.map(toNamedModel),
			overrides,
			(override) => toNamedModel(override.modelId),
		).map((entry) => entry.id);
		return deps.staticModels(ids);
	}

	let catalog: CodexModelCatalogBody | null = null;
	try {
		catalog = await deps.getCatalog();
	} catch (error) {
		// Defensive: the cache is written to swallow its own failures, so reaching
		// here means something unforeseen. Still not a reason to fail the snapshot.
		log.warn(
			"Model-catalog lookup threw; snapshotting the static list instead:",
			error instanceof Error ? error.message : String(error),
		);
	}

	if (!catalog) {
		// Acknowledged limitation, carried over verbatim: this is the OpenAI list
		// shape, NOT the Codex catalog envelope, so the Codex CLI ignores it and
		// uses its built-in catalog. Curation copied on this path therefore
		// reaches generic OpenAI clients only. Building a catalog envelope instead
		// would mean inventing the ~34 fields per entry Codex requires, including
		// each model's own base instructions.
		const ids = applyOverrides(
			deps.staticModelIds.map(toNamedModel),
			overrides,
			(override) => toNamedModel(override.modelId),
		).map((entry) => entry.id);
		return deps.staticModels(ids);
	}

	if (overrides.length === 0) {
		// The uncurated path, byte for byte what shipped before overrides existed:
		// the upstream body verbatim and its own validator.
		const headers = new Headers({ "Content-Type": "application/json" });
		if (catalog.etag) headers.set("ETag", catalog.etag);
		return new Response(catalog.bodyText, { status: 200, headers });
	}

	const curated = applyOverridesToCodexCatalog(catalog.bodyText, overrides);
	if (curated === null) {
		// A catalog we cannot parse is still a catalog Codex can: copy it
		// unmodified rather than losing it over our own curation.
		log.warn(
			"Could not apply model overrides to the Codex catalog; snapshotting it unmodified",
		);
		const headers = new Headers({ "Content-Type": "application/json" });
		if (catalog.etag) headers.set("ETag", catalog.etag);
		return new Response(catalog.bodyText, { status: 200, headers });
	}

	// No ETag: the body is ours now, not upstream's.
	return new Response(curated, {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * The curation for `dialect`, or none.
 *
 * Guarded twice over, because a snapshot must not depend on the database being
 * responsive: a rejection is caught, and a read that never settles is abandoned
 * at {@link OVERRIDE_READ_BUDGET_MS}. Both degrade to "no overrides", which is
 * the uncurated catalogue rather than a failed migration.
 */
async function readOverrides(
	deps: LegacyCatalogueDeps,
	dialect: ModelOverrideDialect,
): Promise<readonly ModelOverride[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<readonly ModelOverride[]>((resolve) => {
		timer = setTimeout(() => {
			log.warn(
				"Model-override read exceeded its budget; snapshotting the uncurated catalogue",
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
				"Could not read the model overrides; snapshotting the uncurated catalogue:",
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
	deps: LegacyCatalogueDeps,
	overrides: readonly ModelOverride[],
): Promise<Response> {
	let snapshot: AnthropicModelCatalogSnapshot | null = null;
	try {
		snapshot = await deps.getAnthropicCatalog();
	} catch (error) {
		// Defensive: the cache resolves rather than rejects, so reaching here means
		// something unforeseen. The reply is then built from the curation alone,
		// which still answers 200 rather than failing the migration.
		log.warn(
			"Anthropic model-catalogue lookup threw; snapshotting the curation alone:",
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

interface OverrideIndex {
	/** Baseline ids to drop. */
	hidden: ReadonlySet<string>;
	/** Id → replacement display name, for baseline AND custom entries alike. */
	displayNames: ReadonlyMap<string, string>;
	/**
	 * Custom rows the baseline does not already contain, oldest first. A custom
	 * row whose id DOES collide with a baseline entry is not an addition: it can
	 * only act as a rename of the entry that is already there, which is what
	 * `displayNames` does with it.
	 */
	additions: readonly ModelOverride[];
}

/**
 * Reduce the rows to the three decisions a caller actually makes.
 *
 * Split from `applyOverrides` because one caller — the Codex catalogue path —
 * cannot use the generic apply: its entries carry model-specific upstream
 * fields that must survive untouched, so it edits them in place against this
 * index instead of being handed rebuilt ones.
 */
function indexOverrides(
	baselineIds: Iterable<string>,
	overrides: readonly ModelOverride[],
): OverrideIndex {
	const baseline = new Set(baselineIds);
	const hidden = new Set<string>();
	const displayNames = new Map<string, string>();
	const additions: ModelOverride[] = [];

	for (const override of overrides) {
		if (override.hidden) {
			hidden.add(override.modelId);
			// A hidden entry is not shown at all, so a name for it is moot.
			continue;
		}
		if (override.displayName !== null && override.displayName !== "") {
			displayNames.set(override.modelId, override.displayName);
		}
		if (override.custom && !baseline.has(override.modelId)) {
			additions.push(override);
		}
	}

	// Oldest first, id as the tiebreak: two rows written in the same millisecond
	// still order deterministically.
	additions.sort(
		(a, b) => a.createdAt - b.createdAt || a.modelId.localeCompare(b.modelId),
	);

	return { hidden, displayNames, additions };
}

/**
 * The baseline with the curation applied: hidden entries dropped, names
 * replaced, custom entries appended.
 *
 * Ids are deduplicated, first occurrence winning. Upstream should not repeat an
 * id, but a duplicate reaching a client is a picker with two identical rows and
 * a rename that appears to apply to only one of them.
 */
function applyOverrides<T extends NamedModel>(
	baseline: readonly T[],
	overrides: readonly ModelOverride[],
	createEntry: (override: ModelOverride) => T,
): T[] {
	const index = indexOverrides(
		baseline.map((entry) => entry.id),
		overrides,
	);

	const seen = new Set<string>();
	const composed: T[] = [];
	for (const entry of baseline) {
		if (index.hidden.has(entry.id)) continue;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const renamed = index.displayNames.get(entry.id);
		composed.push(renamed ? { ...entry, displayName: renamed } : entry);
	}
	for (const addition of index.additions) {
		if (seen.has(addition.modelId)) continue;
		seen.add(addition.modelId);
		composed.push(createEntry(addition));
	}
	return composed;
}

/**
 * Re-serialize the Codex catalog with the curation applied, or null when the
 * body is not the envelope we know how to edit.
 *
 * Entries are carried through as objects rather than rebuilt: Codex requires
 * model-specific fields — reasoning levels, context window, the model's own
 * `base_instructions` — and a rebuild that quietly dropped one would look
 * exactly like success from here while the CLI fell back to its built-in
 * catalog. Only display names are edited; unknown custom entries cannot borrow
 * another target's capabilities.
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
