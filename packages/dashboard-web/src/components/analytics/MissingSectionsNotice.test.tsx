import { describe, expect, it } from "bun:test";
import type { AnalyticsResponse, AnalyticsSection } from "@clankermux/types";
import { renderToStaticMarkup } from "react-dom/server";
import { MissingSectionsNotice } from "./MissingSectionsNotice";

function response(sections: AnalyticsSection[]): AnalyticsResponse {
	return {
		meta: { range: "24h", bucket: "1h", cumulative: false, sections },
	};
}

describe("MissingSectionsNotice", () => {
	it("renders nothing when every requested section came back", () => {
		const html = renderToStaticMarkup(
			<MissingSectionsNotice
				analytics={response(["totals", "routing"])}
				requested={["totals", "routing"]}
			/>,
		);
		expect(html).toBe("");
	});

	it("renders nothing before the first response arrives", () => {
		const html = renderToStaticMarkup(
			<MissingSectionsNotice analytics={undefined} requested={["totals"]} />,
		);
		expect(html).toBe("");
	});

	it("names the sections the server did not compute", () => {
		// The panels backed by `routing` would otherwise render blank — identical
		// to "no routing decisions in this range", which is the wrong conclusion.
		const html = renderToStaticMarkup(
			<MissingSectionsNotice
				analytics={response(["totals"])}
				requested={["totals", "routing", "toolCallErrors"]}
			/>,
		);
		expect(html).toContain("routing");
		expect(html).toContain("toolCallErrors");
		expect(html).not.toContain("totals,");
	});

	it("stays silent for a pre-sections server that sends no meta.sections", () => {
		const legacy = {
			meta: { range: "24h", bucket: "1h" },
		} as AnalyticsResponse;
		const html = renderToStaticMarkup(
			<MissingSectionsNotice analytics={legacy} requested={["routing"]} />,
		);
		expect(html).toBe("");
	});
});
