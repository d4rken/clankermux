/**
 * The control that decides what happens when a provider answers as a model
 * other than the one it was sent.
 *
 * The summary text is the substance here, not decoration: `enforce` converts a
 * working 200 into a retryable 503 when every account substitutes, and
 * `observe` is the rollback that exists because substitution has been measured
 * on exactly one provider. A row that said only "on" and "off" would hide both.
 */

import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSubstitutionSettingsCard } from "./ModelSubstitutionSettingsCard";

type Mode = "off" | "observe" | "enforce";

function render(mode: Mode | undefined, exceptions: string[] = []): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
	if (mode !== undefined) {
		queryClient.setQueryData(["model-substitution-mode"], {
			servedModelSubstitutionMode: mode,
			servedModelSubstitutionExceptions: exceptions,
		});
	}
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<ModelSubstitutionSettingsCard />
		</QueryClientProvider>,
	);
}

describe("ModelSubstitutionSettingsCard", () => {
	it("names the setting and what it is for", () => {
		const html = render("enforce");
		expect(html).toContain("Model Substitution");
		expect(html).toContain("different model than the one they were sent");
	});

	it("says what enforce actually does to a request", () => {
		const html = render("enforce");
		expect(html).toContain("Fail the attempt over");
		expect(html).toContain("five minutes");
	});

	it("describes observe as reporting without failing over", () => {
		const html = render("observe");
		expect(html).toContain("serve the substituted answer anyway");
	});

	it("says off still records the served model", () => {
		const html = render("off");
		expect(html).toContain("forwarded as if correct");
	});

	// Before the first read lands, the row must not claim the feature is off:
	// the server default is enforce, and showing "Off" would invite an operator
	// to "fix" a setting that was never wrong.
	it("assumes the server default while loading", () => {
		const html = render(undefined);
		expect(html).toContain("Fail the attempt over");
	});
});

describe("ModelSubstitutionSettingsCard — accepted swaps", () => {
	it("offers the exception editor", () => {
		const html = render("enforce");
		expect(html).toContain("Accepted swaps");
		expect(html).toContain("Add swap");
	});

	// The row has to say what an exception does NOT do, or it reads as a mute
	// button and an operator loses the data along with the alert.
	it("says an accepted swap is still reported", () => {
		const html = render("enforce");
		expect(html).toContain("report but not act on");
	});

	it("shows the configured pairs as editable fields", () => {
		const html = render("enforce", ["gpt-5.6-luna>gpt-6-luna"]);
		expect(html).toContain('value="gpt-5.6-luna"');
		expect(html).toContain('value="gpt-6-luna"');
	});

	it("says so when nothing is accepted", () => {
		const html = render("enforce");
		expect(html).toContain("every substitution is treated the same way");
	});
});
