import { expect, it } from "bun:test";
import type { RoutingAttempt } from "@clankermux/types";
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
					reasoning_effort_requested: null,
					reasoning_effort_effective: null,
					reasoning_effort_reason: null,
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
						reasoning_effort_requested: null,
						reasoning_effort_effective: null,
						reasoning_effort_reason: null,
					},
				]}
			/>,
		);
		expect(html).toContain(expected);
		expect(html).toContain("Rejected locally");
		expect(html).toContain("Denied");
	});
}

const attempt = (overrides: Partial<RoutingAttempt> = {}): RoutingAttempt => ({
	id: "a",
	request_id: "r",
	rule_id: null,
	route_snapshot: "{}",
	account_id: "codex-account",
	provider: "codex",
	requested_model: "gpt-5.5-codex",
	resolved_model: "gpt-5.5-codex",
	outgoing_model: "gpt-5.5-codex",
	reported_model: null,
	kind: "upstream_send",
	started_at: 1,
	finished_at: 2,
	status: 200,
	error: null,
	reasoning_effort_requested: null,
	reasoning_effort_effective: null,
	reasoning_effort_reason: null,
	...overrides,
});

it("reads an adaptation as asked-for, sent and why", () => {
	const html = renderToStaticMarkup(
		<RoutingAttemptList
			attempts={[
				attempt({
					reasoning_effort_requested: "minimal",
					reasoning_effort_effective: "low",
					reasoning_effort_reason: "chatgpt_backend_clamp",
				}),
			]}
		/>,
	);
	expect(html).toContain("asked for minimal");
	expect(html).toContain("sent low");
	expect(html).toContain(
		"the backend does not accept that effort for this model",
	);
});

it("names a proxy-supplied effort as requested by nobody", () => {
	const html = renderToStaticMarkup(
		<RoutingAttemptList
			attempts={[
				attempt({
					reasoning_effort_requested: null,
					reasoning_effort_effective: "medium",
					reasoning_effort_reason: "proxy_default",
				}),
			]}
		/>,
	);
	expect(html).toContain("none requested, sent medium");
	expect(html).toContain("the request carried no reasoning effort");
	expect(html).not.toContain("asked for");
});

it("spells out every mechanism behind a composite reason", () => {
	const html = renderToStaticMarkup(
		<RoutingAttemptList
			attempts={[
				attempt({
					reasoning_effort_requested: "ultra",
					reasoning_effort_effective: "xhigh",
					reasoning_effort_reason: "target_model_profile+chatgpt_backend_clamp",
				}),
			]}
		/>,
	);
	expect(html).toContain("the target model has no such effort level and");
	expect(html).toContain(
		"the backend does not accept that effort for this model",
	);
});

for (const [label, overrides] of [
	[
		"nothing was adapted",
		{ reasoning_effort_requested: "high", reasoning_effort_effective: "high" },
	],
	["no effort was sent at all", {}],
] as const) {
	it(`renders no reasoning-effort line when ${label}`, () => {
		const html = renderToStaticMarkup(
			<RoutingAttemptList attempts={[attempt(overrides)]} />,
		);
		expect(html).not.toContain("Reasoning effort");
	});
}
