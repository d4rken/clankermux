/**
 * `GET /api/api-keys` carries the harness each key is set up as, because the
 * dashboard renders a client by id in places that have no room for a second
 * column. Against a real database: the value comes from `client_profiles`, a
 * different table from the one the rest of the response is read out of, and a
 * broken join would read as "no client has a harness" rather than as an error.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseOperations } from "@clankermux/database";
import type { ClientProfile } from "@clankermux/types";
import { generateApiKey, listApiKeys, renameApiKey } from "../admin/api-keys";

let dir: string;
let dbOps: DatabaseOperations;

const emptyCatalogues: ClientProfile["catalogues"] = {
	anthropic: { models: [], defaultModel: null },
	openai: { models: [], defaultModel: null },
	codex: { models: [], defaultModel: null },
};

function giveProfile(
	apiKeyId: string,
	application: ClientProfile["application"],
): void {
	dbOps.clients.insertInTransaction({
		apiKeyId,
		application,
		revision: 1,
		catalogues: emptyCatalogues,
		notices: [],
	});
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "clankermux-apikey-app-"));
	dbOps = new DatabaseOperations(path.join(dir, "test.db"));
});

afterEach(() => {
	dbOps.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

it("gives each client on one machine its own harness", async () => {
	// The shape the whole feature exists for: several clients differing only by
	// which harness they are, whose names today carry a hand-written suffix to
	// say so. `api_keys.name` is UNIQUE, so the suffix is load-bearing for the
	// name too — these keys cannot simply be called "splurge" three times.
	const pi = await generateApiKey(dbOps, "splurge (pi)");
	const codex = await generateApiKey(dbOps, "splurge (codex)");
	const cc = await generateApiKey(dbOps, "splurge (claudecode)");
	giveProfile(pi.id, "pi");
	giveProfile(codex.id, "codex");
	giveProfile(cc.id, "claude-code");

	const byId = new Map((await listApiKeys(dbOps)).map((k) => [k.id, k]));
	expect(byId.get(pi.id)?.application).toBe("pi");
	expect(byId.get(codex.id)?.application).toBe("codex");
	expect(byId.get(cc.id)?.application).toBe("claude-code");
});

it("reports null for a key that was never set up as a client", async () => {
	// A key minted outside the client wizard has no profile. Null, not
	// "generic": nothing ever told this key what it talks to, and claiming a
	// harness would put a mark on a row that has not earned one.
	const bare = await generateApiKey(dbOps, "scripted");

	const [key] = await listApiKeys(dbOps);
	expect(key?.id).toBe(bare.id);
	expect(key?.application).toBeNull();
});

it("carries the harness on a rename response, not just the list", async () => {
	// The dashboard writes this response straight into the cache the labels
	// read, so a null here would blank the mark until the next list refetch.
	const key = await generateApiKey(dbOps, "before");
	giveProfile(key.id, "opencode");

	const renamed = await renameApiKey(dbOps, "before", "after");
	expect(renamed.name).toBe("after");
	expect(renamed.application).toBe("opencode");
});
