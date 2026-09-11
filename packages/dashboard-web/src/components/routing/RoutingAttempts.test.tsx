import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutingAttemptList } from "./RoutingAttempts";

it("distinguishes requested, sent and unreported model identities", () => {
	const html = renderToStaticMarkup(
		<RoutingAttemptList
			attempts={[
				{
					id: "a",
					request_id: "r",
					rule_id: null,
					route_snapshot: "{}",
					account_id: "codex-account",
					provider: "codex",
					requested_model: "claude-fable-5-1",
					resolved_model: "gpt-6-astra",
					outgoing_model: "gpt-6-astra",
					reported_model: null,
					kind: "upstream_send",
					started_at: 1,
					finished_at: 2,
					status: 200,
					error: null,
				},
			]}
		/>,
	);
	expect(html).toContain("claude-fable-5-1");
	expect(html).toContain("gpt-6-astra");
	expect(html).toContain("Not reported");
	expect(html).toContain("Sent upstream");
});

for (const [snapshot, expected] of [
	[null, "Snapshot no longer retained"],
	["not-json", "Snapshot unavailable"],
] as const) {
	it(`keeps attempt details usable for snapshot ${snapshot}`, () => {
		const html = renderToStaticMarkup(
			<RoutingAttemptList
				attempts={[
					{
						id: "a",
						request_id: "r",
						rule_id: null,
						route_snapshot: snapshot,
						account_id: null,
						provider: null,
						requested_model: "requested",
						resolved_model: null,
						outgoing_model: null,
						reported_model: null,
						kind: "local_reject",
						started_at: 1,
						finished_at: 2,
						status: 403,
						error: "Denied",
					},
				]}
			/>,
		);
		expect(html).toContain(expected);
		expect(html).toContain("Rejected locally");
		expect(html).toContain("Denied");
	});
}
