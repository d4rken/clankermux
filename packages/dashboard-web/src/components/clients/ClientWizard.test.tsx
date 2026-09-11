import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientWizard } from "./ClientWizard";

it("starts with a named installation and leaves creation until review", () => {
	const html = renderToStaticMarkup(
		<ClientWizard accounts={[]} onCancel={() => {}} onSaved={() => {}} />,
	);
	expect(html).toContain("Client name");
	expect(html).toContain("Generic / script");
	expect(html).toContain("Next");
	expect(html).not.toContain("Create client");
});
