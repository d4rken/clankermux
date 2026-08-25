import { validateString } from "@clankermux/core";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@clankermux/http-common";
import type {
	ModelCatalogResponse,
	ModelDialect,
	ModelOverrideSetRequest,
} from "@clankermux/types";

/**
 * Longest model id we will store.
 *
 * Generous next to any real slug (`claude-sonnet-4-5-20250929` is 26 characters)
 * and small enough that a pasted document cannot become a row that then renders
 * in a list on every dashboard load.
 */
const MAX_MODEL_ID_LENGTH = 200;

/** Same reasoning for the label, with room for a sentence of description. */
const MAX_DISPLAY_NAME_LENGTH = 200;

const DIALECTS: readonly ModelDialect[] = ["anthropic", "openai"];

/**
 * The model catalogue this server serves, and the operator's edits to it.
 *
 * Reads and writes go through the SAME service the wire route uses, so the page
 * cannot show a list that `/v1/models` would not serve. This module owns only
 * the HTTP contract: which parameters exist, what a malformed body is, and what
 * an edit means.
 */
export interface ModelOverrideHandlerDeps {
	getCatalog(dialect: ModelDialect): Promise<ModelCatalogResponse>;
	setOverride(input: {
		dialect: ModelDialect;
		modelId: string;
		hidden: boolean;
		custom: boolean;
		displayName: string | null;
	}): Promise<void>;
	removeOverride(dialect: ModelDialect, modelId: string): Promise<boolean>;
}

export function createModelOverrideHandlers(deps: ModelOverrideHandlerDeps) {
	return {
		/** `GET /api/models/catalog?dialect=…` — the editing view. */
		getCatalog: async (url: URL): Promise<Response> => {
			const dialect = readDialect(url.searchParams.get("dialect"));
			if (!dialect) {
				return errorResponse(
					BadRequest("Invalid 'dialect': must be anthropic or openai"),
				);
			}
			try {
				return jsonResponse(await deps.getCatalog(dialect));
			} catch (error) {
				return errorResponse(error);
			}
		},

		/**
		 * `POST /api/models/overrides` — write one row.
		 *
		 * FULL REPLACEMENT, not a merge: the caller sends the complete state of
		 * the row it renders. A partial body would make two edits made from the
		 * same page combine into a state neither of them asked for — the classic
		 * shape of "I un-hid it and my rename disappeared".
		 */
		setOverride: async (req: Request): Promise<Response> => {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(BadRequest("Body must be JSON"));
			}
			if (typeof body !== "object" || body === null || Array.isArray(body)) {
				return errorResponse(BadRequest("Body must be a JSON object"));
			}
			const input = body as Partial<ModelOverrideSetRequest>;

			const dialect = readDialect(input.dialect);
			if (!dialect) {
				return errorResponse(
					BadRequest("Invalid 'dialect': must be anthropic or openai"),
				);
			}
			if (typeof input.hidden !== "boolean") {
				return errorResponse(BadRequest("Invalid 'hidden': must be boolean"));
			}
			if (typeof input.custom !== "boolean") {
				return errorResponse(BadRequest("Invalid 'custom': must be boolean"));
			}
			if (input.hidden && input.custom) {
				// The storage layer refuses this too. Hiding an entry that exists only
				// because it was added here is a delete, not a state.
				return errorResponse(
					BadRequest("A model cannot be both hidden and custom"),
				);
			}
			if (
				input.displayName !== null &&
				input.displayName !== undefined &&
				typeof input.displayName !== "string"
			) {
				return errorResponse(
					BadRequest("Invalid 'displayName': must be a string or null"),
				);
			}

			let modelId: string | undefined;
			let displayName: string | undefined;
			try {
				modelId = validateString(input.modelId, "modelId", {
					required: true,
					minLength: 1,
					maxLength: MAX_MODEL_ID_LENGTH,
					transform: (value) => value.trim(),
				});
				displayName = validateString(input.displayName, "displayName", {
					maxLength: MAX_DISPLAY_NAME_LENGTH,
					transform: (value) => value.trim(),
				});
			} catch (error) {
				return errorResponse(error);
			}
			if (!modelId) {
				return errorResponse(
					BadRequest("Invalid 'modelId': must be non-empty"),
				);
			}

			try {
				await deps.setOverride({
					dialect,
					modelId,
					hidden: input.hidden,
					custom: input.custom,
					// A blank name is not a name. Normalising it to null here means the
					// row can then be recognised as a no-op and deleted rather than
					// stored as "renamed to nothing".
					displayName:
						displayName === undefined || displayName === ""
							? null
							: displayName,
				});
				return new Response(null, { status: 204 });
			} catch (error) {
				return errorResponse(error);
			}
		},

		/** `DELETE /api/models/overrides?dialect=…&modelId=…`. */
		removeOverride: async (url: URL): Promise<Response> => {
			const dialect = readDialect(url.searchParams.get("dialect"));
			if (!dialect) {
				return errorResponse(
					BadRequest("Invalid 'dialect': must be anthropic or openai"),
				);
			}
			const modelId = url.searchParams.get("modelId")?.trim();
			if (!modelId) {
				return errorResponse(BadRequest("Missing 'modelId'"));
			}
			try {
				await deps.removeOverride(dialect, modelId);
				// 204 whether or not a row existed: the caller asked for the row to be
				// gone, and it is. A 404 here would make a double-click an error.
				return new Response(null, { status: 204 });
			} catch (error) {
				return errorResponse(error);
			}
		},
	};
}

function readDialect(value: unknown): ModelDialect | null {
	return typeof value === "string" && DIALECTS.includes(value as ModelDialect)
		? (value as ModelDialect)
		: null;
}
