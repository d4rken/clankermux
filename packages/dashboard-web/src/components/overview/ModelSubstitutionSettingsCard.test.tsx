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

function render(mode: Mode | undefined): string {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnMount: false } },
	});
	if (mode !== undefined) {
		queryClient.setQueryData(["model-substitution-mode"], {
			servedModelSubstitutionMode: mode,
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
