import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@clankermux/core";
import { DatabaseOperations } from "@clankermux/database";
import { HttpError } from "@clankermux/errors";
import {
	AccountModelPermissionService,
	type CodexModelCatalogCache,
} from "@clankermux/proxy";
import { tempDbTracker } from "@clankermux/test-support";
import type {
	ClientApplication,
	ClientDraft,
	ClientFormat,
	ClientView,
	GlobalCatalogueDraft,
	GlobalCatalogueModel,
} from "@clankermux/types";
import { ClientService } from "../client-service";
import { ModelCatalogService } from "../model-catalog-service";

const temp = tempDbTracker("client-service-global");
const codexRaw = {
	bodyText: JSON.stringify({
		models: [
			{ slug: "gpt-real", display_name: "gpt-real", context_window: 64000 },
		],
		server_version: "test",
	}),
	etag: "upstream",
};
const entry = (
	id: string,
	targetModel = id,
	accountIds: string[] | null = null,
): GlobalCatalogueModel => ({
	id,
	displayName: id,
	targetModel,
	accountIds,
});
const blank = (
	name: string,
	application: ClientApplication = "pi",
): ClientDraft => ({
	name,
	application,
	destinations: { accountId: null, providers: null },
	catalogues: {
		anthropic: { models: [], defaultModel: null },
		openai: { models: [], defaultModel: null },
		codex: { models: [], defaultModel: null },
	},
});
const edit = (client: ClientView): ClientDraft => ({
	id: client.apiKeyId,
	revision: client.revision,
	name: client.key.name,
	application: client.application,
	destinations: {
		accountId: client.key.pinnedAccountId,
		providers: client.key.pinnedProviders,
		excludedProviders: client.key.excludedProviders ?? null,
	},
	catalogues: structuredClone(client.catalogues),
});
const ids = (client: ClientView | undefined, format: ClientFormat) =>
	client?.catalogues[format].models.map((m) => m.id);

describe("global catalogue", () => {
	let dbOps: DatabaseOperations;
	let service: ClientService;
	let permissions: AccountModelPermissionService;
	beforeEach(() => {
		dbOps = new DatabaseOperations(temp.next());
		for (const [id, provider] of [
			["c", "codex"],
			["d", "devin"],
		])
			dbOps
				.getAdapter()
				.getSQLiteDb()
				.query(
					"INSERT INTO accounts(id,name,provider,created_at) VALUES(?,?,?,?)",
				)
				.run(id, id, provider, 100);
		permissions = new AccountModelPermissionService({
			repository: dbOps.routing,
			listAccounts: () => dbOps.getAllAccounts(),
			getAccessToken: async () => {
				throw new Error("No test network");
			},
		});
		const codex = {
			getForPin: async (pin: {
				accountId: string | null;
				providers: string[] | null;
			}) =>
				pin.accountId === "d" ||
				(pin.providers && !pin.providers.includes("codex"))
					? null
					: codexRaw,
		} as unknown as CodexModelCatalogCache;
		service = new ClientService({
			dbOps,
			permissions,
			codexCatalog: codex,
			modelCatalog: new ModelCatalogService({
				anthropicCatalog: {
					get: async () => ({ models: [], source: "upstream", fetchedAt: 100 }),
				},
				codexCatalog: { get: async () => codexRaw },
				staticModelIds: ["gpt-static"],
			}),
		});
	});
	afterEach(async () => {
		permissions.stop();
		await dbOps.dispose();
		temp.cleanup();
	});

	async function makeClient(
		name: string,
		application: ClientApplication = "pi",
		shape?: (draft: ClientDraft) => void,
	): Promise<ClientView> {
		const draft = blank(name, application);
		shape?.(draft);
		return (await service.commit((await service.review(draft)).token)).client;
	}
	async function client(id: string): Promise<ClientView> {
		const found = (await service.list()).find((c) => c.apiKeyId === id);
		if (!found) throw new Error(`no client ${id}`);
		return found;
	}
	async function globalDraft(
		shape: Partial<Record<ClientFormat, string[]>>,
		subscribers: string[],
		defaults: Partial<Record<ClientFormat, string>> = {},
	): Promise<GlobalCatalogueDraft> {
		const current = await service.globalCatalogue();
		const format = (f: ClientFormat) => ({
			models: (shape[f] ?? []).map((id) => entry(id)),
			defaultModel: defaults[f] ?? null,
		});
		return {
			revision: current.revision,
			catalogues: {
				anthropic: format("anthropic"),
				openai: format("openai"),
				codex: format("codex"),
			},
			subscribers,
		};
	}
	async function applyGlobal(draft: GlobalCatalogueDraft) {
		const review = await service.globalReview(draft);
		await service.globalCommit(review.token);
		return review;
	}
	async function status(work: Promise<unknown>): Promise<number> {
		try {
			await work;
		} catch (error) {
			return error instanceof HttpError ? error.status : -1;
		}
		return 0;
	}

	it("starts a joining client from the global catalogue in its application's format only", async () => {
		const pi = await makeClient("Pi", "pi", (d) => {
			d.catalogues.openai.models = [entry("local-a")];
			d.catalogues.anthropic.models = [entry("claude-local")];
		});
		const other = await makeClient("Other", "pi", (d) => {
			d.catalogues.openai.models = [entry("untouched")];
		});
		const review = await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId], {
				openai: "g1",
			}),
		);
		expect(review.clients).toEqual([
			expect.objectContaining({
				apiKeyId: pi.apiKeyId,
				status: "changed",
				subscription: "joins",
				formats: {
					openai: expect.objectContaining({
						added: ["g1", "g2"],
						removed: ["local-a"],
						defaultModelChange: { from: null, to: "g1" },
						skipped: [],
					}),
				},
			}),
		]);
		const after = await client(pi.apiKeyId);
		expect(ids(after, "openai")).toEqual(["g1", "g2"]);
		expect(after.catalogues.openai.defaultModel).toBe("g1");
		expect(ids(after, "anthropic")).toEqual(["claude-local"]);
		expect(after.global).toEqual({
			appliedRevision: 1,
			formats: {
				openai: {
					additions: [],
					removals: [],
					inheritDefault: true,
					defaultModel: null,
					skipped: [],
				},
			},
		});
		expect(ids(await client(other.apiKeyId), "openai")).toEqual(["untouched"]);
		expect(await service.globalCatalogue()).toEqual(
			expect.objectContaining({ revision: 1, subscribers: [pi.apiKeyId] }),
		);
	});

	it("carries a global edit to every subscriber in one commit", async () => {
		const a = await makeClient("A");
		const b = await makeClient("B", "opencode");
		await applyGlobal(
			await globalDraft({ openai: ["g1"] }, [a.apiKeyId, b.apiKeyId]),
		);
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g3"] }, [a.apiKeyId, b.apiKeyId]),
		);
		for (const id of [a.apiKeyId, b.apiKeyId]) {
			const after = await client(id);
			expect(ids(after, "openai")).toEqual(["g1", "g3"]);
			expect(after.global?.appliedRevision).toBe(2);
		}
	});

	it("composes a client's additions, removals and overrides over the global catalogue", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		const draft = edit(await client(pi.apiKeyId));
		draft.global = {
			formats: {
				openai: {
					additions: [
						entry("mine"),
						{ ...entry("g1"), displayName: "Mine G1" },
						// Identical to its global entry: not an override.
						entry("g2"),
					],
					removals: ["g2"],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		expect(await status(service.review(draft))).toBe(400);
		draft.global.formats.openai?.additions.pop();
		await service.commit((await service.review(draft)).token);
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2", "g3"] }, [pi.apiKeyId]),
		);
		const after = await client(pi.apiKeyId);
		expect(
			after.catalogues.openai.models.map((m) => [m.id, m.displayName]),
		).toEqual([
			["g1", "Mine G1"],
			["g3", "g3"],
			["mine", "mine"],
		]);
		expect(after.global?.formats.openai?.removals).toEqual(["g2"]);
	});

	it("drops an addition identical to its global entry so the client follows later global edits", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		const draft = edit(await client(pi.apiKeyId));
		draft.global = {
			formats: {
				openai: {
					additions: [entry("g1")],
					removals: [],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		await service.commit((await service.review(draft)).token);
		expect(
			(await client(pi.apiKeyId)).global?.formats.openai?.additions,
		).toEqual([]);
	});

	it("skips a global entry a client cannot publish, says why, and publishes it where it can", async () => {
		const cc = await makeClient("CC", "claude-code");
		const generic = await makeClient("Generic", "generic");
		const review = await applyGlobal(
			await globalDraft({ anthropic: ["claude-ok", "gpt-nope"] }, [
				cc.apiKeyId,
				generic.apiKeyId,
			]),
		);
		const skipped = [
			{
				id: "gpt-nope",
				reason: "Claude Code requires a compatible alias for gpt-nope",
			},
		];
		expect(
			review.clients.find((c) => c.apiKeyId === cc.apiKeyId)?.formats.anthropic
				?.skipped,
		).toEqual(skipped);
		const ccAfter = await client(cc.apiKeyId);
		expect(ids(ccAfter, "anthropic")).toEqual(["claude-ok"]);
		expect(ccAfter.global?.formats.anthropic?.skipped).toEqual(skipped);
		expect(ids(await client(generic.apiKeyId), "anthropic")).toEqual([
			"claude-ok",
			"gpt-nope",
		]);
	});

	it("still refuses a client's own entry that it cannot publish", async () => {
		const cc = await makeClient("CC", "claude-code");
		await applyGlobal(await globalDraft({}, [cc.apiKeyId]));
		const draft = edit(await client(cc.apiKeyId));
		draft.global = {
			formats: {
				anthropic: {
					additions: [entry("gpt-nope")],
					removals: [],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		expect(await status(service.review(draft))).toBe(400);
	});

	it("rejects a malformed global catalogue before recomposing any client", async () => {
		const pi = await makeClient("Pi");
		const base = await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]);
		const variants: Array<(d: GlobalCatalogueDraft) => void> = [
			(d) => d.catalogues.openai.models.push(entry("g1")),
			(d) => d.catalogues.openai.models.push(entry("x", "alias:missing")),
			(d) => d.catalogues.openai.models.push(entry("x", "x", ["nobody"])),
			(d) => d.catalogues.openai.models.push(entry("renamed", "gpt-static")),
			(d) => {
				d.catalogues.openai.defaultModel = "unlisted";
			},
			(d) => {
				d.catalogues.openai.models.push(entry("fast", "gpt-a", ["c"]));
				d.catalogues.codex.models.push(entry("fast", "gpt-b", ["c"]));
			},
			(d) => {
				d.subscribers = ["no-such-client"];
			},
		];
		for (const variant of variants) {
			const draft = structuredClone(base);
			variant(draft);
			expect(await status(service.globalReview(draft))).toBe(400);
		}
		expect(await status(service.globalReview({ ...base, revision: 7 }))).toBe(
			409,
		);
		expect(ids(await client(pi.apiKeyId), "openai")).toEqual([]);
	});

	it("inherits the global default only while the client publishes it", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId], {
				openai: "g1",
			}),
		);
		const draft = edit(await client(pi.apiKeyId));
		draft.global = {
			formats: {
				openai: {
					additions: [],
					removals: ["g1"],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		await service.commit((await service.review(draft)).token);
		expect((await client(pi.apiKeyId)).catalogues.openai.defaultModel).toBe(
			null,
		);
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId], {
				openai: "g2",
			}),
		);
		expect((await client(pi.apiKeyId)).catalogues.openai.defaultModel).toBe(
			"g2",
		);
	});

	it("keeps an explicit client default as the client's choice, published while its model is", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId], {
				openai: "g1",
			}),
		);
		const draft = edit(await client(pi.apiKeyId));
		draft.global = {
			formats: {
				openai: {
					additions: [],
					removals: [],
					inheritDefault: false,
					defaultModel: "g2",
				},
			},
		};
		await service.commit((await service.review(draft)).token);
		expect((await client(pi.apiKeyId)).catalogues.openai.defaultModel).toBe(
			"g2",
		);
		const review = await applyGlobal(
			await globalDraft({ openai: ["g1"] }, [pi.apiKeyId], { openai: "g1" }),
		);
		expect(review.clients[0]?.formats.openai?.defaultModelChange).toEqual({
			from: "g2",
			to: null,
		});
		const after = await client(pi.apiKeyId);
		expect(after.catalogues.openai.defaultModel).toBe(null);
		expect(after.global?.formats.openai?.defaultModel).toBe("g2");
	});

	it("keeps what a leaving client publishes as its own catalogue", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		const review = await applyGlobal(await globalDraft({ openai: ["g1"] }, []));
		expect(review.clients[0]).toEqual(
			expect.objectContaining({ subscription: "leaves", status: "changed" }),
		);
		const after = await client(pi.apiKeyId);
		expect(after.global).toBe(null);
		expect(ids(after, "openai")).toEqual(["g1"]);
		await applyGlobal(await globalDraft({ openai: ["g9"] }, []));
		expect(ids(await client(pi.apiKeyId), "openai")).toEqual(["g1"]);
	});

	it("keeps the subscription when a draft says nothing about it, and ends it on null", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		const keep = edit(await client(pi.apiKeyId));
		keep.catalogues.openai.models = [entry("ignored")];
		await service.commit((await service.review(keep)).token);
		const kept = await client(pi.apiKeyId);
		expect(ids(kept, "openai")).toEqual(["g1"]);
		expect(kept.global).not.toBe(null);
		const leave = edit(kept);
		leave.global = null;
		leave.catalogues.openai.models = [entry("own")];
		await service.commit((await service.review(leave)).token);
		const left = await client(pi.apiKeyId);
		expect(left.global).toBe(null);
		expect(ids(left, "openai")).toEqual(["own"]);
	});

	it("moves the global catalogue to the new format when a client's application changes", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"], codex: ["gpt-real"] }, [
				pi.apiKeyId,
			]),
		);
		const removal = edit(await client(pi.apiKeyId));
		removal.global = {
			formats: {
				openai: {
					additions: [],
					removals: ["g2"],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		await service.commit((await service.review(removal)).token);
		const toCodex = edit(await client(pi.apiKeyId));
		toCodex.application = "codex";
		await service.commit((await service.review(toCodex)).token);
		const after = await client(pi.apiKeyId);
		expect(ids(after, "codex")).toEqual(["gpt-real"]);
		expect(after.catalogues.codex.models[0]?.codexMetadata).toEqual(
			expect.objectContaining({ slug: "gpt-real" }),
		);
		expect(ids(after, "openai")).toEqual(["g1"]);
		expect(Object.keys(after.global?.formats ?? {})).toEqual(["codex"]);
	});

	it("refuses a global commit when a subscriber changed after the review", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		const review = await service.globalReview(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		const rename = edit(await client(pi.apiKeyId));
		rename.name = "Renamed";
		await service.commit((await service.review(rename)).token);
		await expect(service.globalCommit(review.token)).rejects.toThrow();
		expect((await service.globalCatalogue()).revision).toBe(1);
		expect(ids(await client(pi.apiKeyId), "openai")).toEqual(["g1"]);
	});

	it("refuses a client commit when the global catalogue changed after its review", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		const review = await service.review(edit(await client(pi.apiKeyId)));
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		await expect(service.commit(review.token)).rejects.toThrow();
		expect(ids(await client(pi.apiKeyId), "openai")).toEqual(["g1", "g2"]);
	});

	it("keeps a subscriber the global edit cannot recompose as it was, and says so", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		const pinned = edit(await client(pi.apiKeyId));
		pinned.global = {
			formats: {
				openai: {
					additions: [entry("mine", "mine", ["c"])],
					removals: [],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		await service.commit((await service.review(pinned)).token);
		await dbOps.updateApiKeyPin(pi.apiKeyId, null, null, ["codex"]);
		const review = await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		expect(review.clients[0]).toEqual(
			expect.objectContaining({
				status: "rejected",
				reason: "Choose allowed accounts for mine",
			}),
		);
		const after = await client(pi.apiKeyId);
		expect(ids(after, "openai")).toEqual(["g1", "mine"]);
		expect(after.notices).toContain(
			"This client has not taken global catalogue revision 2 yet. Review it to apply the global catalogue.",
		);
	});

	it("edits a subscriber's differences, not its published list, in a bulk edit", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		const bulk = async (add: string[], remove: string[]) =>
			service.bulkCommit(
				(
					await service.bulkReview({
						clientIds: [pi.apiKeyId],
						operation: {
							format: "openai",
							mode: "edit",
							add: add.map((id) => entry(id)),
							remove,
						},
					})
				).token,
			);
		await bulk(["new"], ["g1"]);
		let after = await client(pi.apiKeyId);
		expect(ids(after, "openai")).toEqual(["g2", "new"]);
		expect(after.global?.formats.openai).toEqual(
			expect.objectContaining({
				additions: [entry("new")],
				removals: ["g1"],
			}),
		);
		await bulk(["g1"], ["new"]);
		after = await client(pi.apiKeyId);
		expect(ids(after, "openai")).toEqual(["g1", "g2"]);
		expect(after.global?.formats.openai).toEqual(
			expect.objectContaining({ additions: [], removals: [] }),
		);
	});

	it("derives a subscriber's differences from a bulk replacement", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId], {
				openai: "g1",
			}),
		);
		const review = await service.bulkReview({
			clientIds: [pi.apiKeyId],
			operation: {
				format: "openai",
				mode: "replace",
				models: [{ ...entry("g1"), displayName: "Renamed" }, entry("x")],
				defaultModel: "x",
			},
		});
		await service.bulkCommit(review.token);
		const after = await client(pi.apiKeyId);
		expect(ids(after, "openai")).toEqual(["g1", "x"]);
		expect(after.catalogues.openai.defaultModel).toBe("x");
		expect(after.global?.formats.openai).toEqual({
			additions: [{ ...entry("g1"), displayName: "Renamed" }, entry("x")],
			removals: ["g2"],
			inheritDefault: false,
			defaultModel: "x",
			skipped: [],
		});
	});

	it("keeps subscribers' leftover alias routes unless the global edit drops them", async () => {
		const a = await makeClient("A");
		const b = await makeClient("B");
		const withAlias = await globalDraft({ openai: ["g1"] }, [
			a.apiKeyId,
			b.apiKeyId,
		]);
		withAlias.catalogues.openai.models.push(entry("fast", "gpt-static", ["c"]));
		await applyGlobal(withAlias);
		const owned = async () =>
			(await service.list())
				.filter((c) => c.apiKeyId === a.apiKeyId || c.apiKeyId === b.apiKeyId)
				.map((c) => c.aliasRules.map((r) => r.match_model_value));
		expect(await owned()).toEqual([["fast"], ["fast"]]);
		await applyGlobal(
			await globalDraft({ openai: ["g1"] }, [a.apiKeyId, b.apiKeyId]),
		);
		expect(await owned()).toEqual([["fast"], ["fast"]]);
		await applyGlobal({
			...(await globalDraft({ openai: ["g1"] }, [a.apiKeyId, b.apiKeyId])),
			droppedAliasRoutes: ["fast"],
		});
		expect(await owned()).toEqual([[], []]);
	});

	it("lets a client's own alias win over a conflicting global alias in any format", async () => {
		const generic = await makeClient("Generic", "generic");
		const draft = await globalDraft({}, [generic.apiKeyId]);
		draft.catalogues.anthropic.models = [
			entry("claude-fast", "gpt-static", ["c"]),
		];
		draft.catalogues.openai.models = [
			entry("claude-fast", "gpt-static", ["c"]),
		];
		await applyGlobal(draft);
		const own = edit(await client(generic.apiKeyId));
		own.global = {
			formats: {
				openai: {
					additions: [entry("claude-fast", "other", ["c"])],
					removals: [],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		await service.commit((await service.review(own)).token);
		const after = await client(generic.apiKeyId);
		expect(after.catalogues.openai.models.map((m) => m.targetModel)).toEqual([
			"other",
		]);
		expect(ids(after, "anthropic")).toEqual([]);
		expect(after.global?.formats.anthropic?.skipped).toEqual([
			{
				id: "claude-fast",
				reason:
					"This client publishes alias claude-fast with a different target",
			},
		]);
	});

	it("refuses a global commit when a client joined after the review", async () => {
		const a = await makeClient("A");
		const b = await makeClient("B");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [a.apiKeyId]));
		const review = await service.globalReview(
			await globalDraft({ openai: ["g1", "g2"] }, [a.apiKeyId]),
		);
		const join = edit(await client(b.apiKeyId));
		join.global = { formats: {} };
		await service.commit((await service.review(join)).token);
		await expect(service.globalCommit(review.token)).rejects.toThrow();
		expect((await service.globalCatalogue()).revision).toBe(1);
	});

	it("rejects only the subscriber whose catalogue is missing", async () => {
		const a = await makeClient("A");
		const broken = await makeClient("Broken");
		dbOps
			.getAdapter()
			.getSQLiteDb()
			.query("DELETE FROM client_profiles WHERE api_key_id=?")
			.run(broken.apiKeyId);
		const review = await applyGlobal(
			await globalDraft({ openai: ["g1"] }, [a.apiKeyId, broken.apiKeyId]),
		);
		expect(review.clients.find((c) => c.apiKeyId === broken.apiKeyId)).toEqual(
			expect.objectContaining({
				status: "rejected",
				reason: "Client catalogue is missing; configure this client first",
			}),
		);
		expect(ids(await client(a.apiKeyId), "openai")).toEqual(["g1"]);
	});

	it("forgets a removal once the global catalogue drops that model", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		const draft = edit(await client(pi.apiKeyId));
		draft.global = {
			formats: {
				openai: {
					additions: [],
					removals: ["g2"],
					inheritDefault: true,
					defaultModel: null,
				},
			},
		};
		await service.commit((await service.review(draft)).token);
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		expect(
			(await client(pi.apiKeyId)).global?.formats.openai?.removals,
		).toEqual([]);
		await applyGlobal(
			await globalDraft({ openai: ["g1", "g2"] }, [pi.apiKeyId]),
		);
		expect(ids(await client(pi.apiKeyId), "openai")).toEqual(["g1", "g2"]);
	});

	it("says when a bulk edit also brings a subscriber up to the current global revision", async () => {
		const pi = await makeClient("Pi");
		await applyGlobal(await globalDraft({ openai: ["g1"] }, [pi.apiKeyId]));
		// A global save that did not recompose this client, as a rejected one leaves it.
		const next = await globalDraft({ openai: ["g1", "g2"] }, []);
		await dbOps
			.getAdapter()
			.runTransaction(() =>
				dbOps.clients.saveGlobalInTransaction(next.catalogues, 1),
			);
		const review = await service.bulkReview({
			clientIds: [pi.apiKeyId],
			operation: {
				format: "openai",
				mode: "edit",
				add: [entry("x")],
				remove: [],
			},
		});
		expect(review.clients[0]?.notices).toContain(
			"Saving also brings this client up to global catalogue revision 2, which can change its other covered formats too.",
		);
		expect(review.clients[0]?.added).toEqual(["g2", "x"]);
	});
});
