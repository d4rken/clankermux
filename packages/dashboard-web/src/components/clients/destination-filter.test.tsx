import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DestinationAccount } from "./ClientWizard";
import {
	DestinationFilterBar,
	matchesDestinationFilter,
	NO_DESTINATION_FILTER,
	servingAccounts,
	UNKNOWN_PROVIDER,
} from "./destination-filter";

const zai: DestinationAccount = { id: "z1", name: "Z one", provider: "zai" };
const zai2: DestinationAccount = { id: "z2", name: "Z two", provider: "zai" };
const codex: DestinationAccount = {
	id: "c1",
	name: "C one",
	provider: "codex",
};

describe("matchesDestinationFilter", () => {
	it("passes everything when nothing is chosen", () => {
		expect(matchesDestinationFilter([], NO_DESTINATION_FILTER)).toBe(true);
		expect(matchesDestinationFilter([zai], NO_DESTINATION_FILTER)).toBe(true);
	});

	it("keeps a row served by any chosen provider", () => {
		const filter = { providers: ["zai"], accounts: [] };
		expect(matchesDestinationFilter([zai], filter)).toBe(true);
		expect(matchesDestinationFilter([codex, zai], filter)).toBe(true);
		expect(matchesDestinationFilter([codex], filter)).toBe(false);
		expect(matchesDestinationFilter([], filter)).toBe(false);
	});

	it("selects rows no account names through the unknown bucket", () => {
		const filter = { providers: [UNKNOWN_PROVIDER], accounts: [] };
		expect(matchesDestinationFilter([], filter)).toBe(true);
		expect(matchesDestinationFilter([zai], filter)).toBe(false);
	});

	it("narrows to rows served by a chosen account", () => {
		const filter = { providers: ["zai"], accounts: ["z2"] };
		expect(matchesDestinationFilter([zai2], filter)).toBe(true);
		expect(matchesDestinationFilter([zai], filter)).toBe(false);
	});
});

describe("servingAccounts", () => {
	const suggestions = {
		models: [
			{
				id: "glm",
				displayName: "GLM",
				accountIds: ["z1", "deleted"],
				codexMetadataAvailable: false,
			},
		],
		accounts: [],
	};
	const entry = (targetModel: string, accountIds: string[] | null) => ({
		id: "published",
		displayName: "Published",
		targetModel,
		accountIds,
	});

	it("reads a pinned entry's own accounts before discovery", () => {
		expect(
			servingAccounts(entry("glm", ["c1"]), suggestions, [zai, codex]),
		).toEqual([codex]);
	});

	it("falls back to where discovery found the upstream model", () => {
		expect(
			servingAccounts(entry("glm", null), suggestions, [zai, codex]),
		).toEqual([
			zai,
			{ id: "deleted", name: "deleted", provider: UNKNOWN_PROVIDER },
		]);
		expect(servingAccounts(entry("glm", null), null, [zai])).toEqual([]);
		expect(servingAccounts(entry("other", null), suggestions, [zai])).toEqual(
			[],
		);
	});
});

describe("DestinationFilterBar", () => {
	const render = (
		rows: DestinationAccount[][],
		filter = NO_DESTINATION_FILTER,
	) =>
		renderToStaticMarkup(
			<DestinationFilterBar rows={rows} filter={filter} onChange={() => {}} />,
		);

	it("offers each provider with the number of models it serves", () => {
		const html = render([[zai], [zai2], [codex], []]);
		expect(html).toContain('aria-label="Show z.ai models, 2 models"');
		expect(html).toContain('aria-label="Show OpenAI models, 1 model"');
		expect(html).toContain(
			'aria-label="Show Unknown provider models, 1 model"',
		);
		expect(html).not.toContain("Clear filters");
	});

	it("offers only the chosen providers' accounts", () => {
		const html = render([[zai], [zai2], [codex]], {
			providers: ["zai"],
			accounts: [],
		});
		expect(html).toContain('aria-label="Show Z one models, 1 model"');
		expect(html).toContain('aria-label="Show Z two models, 1 model"');
		expect(html).not.toContain("C one");
		expect(html).toContain("Clear filters");
	});

	it("renders nothing when there is nothing to tell apart", () => {
		expect(render([[zai], [zai]])).toBe("");
		expect(render([])).toBe("");
	});
});
