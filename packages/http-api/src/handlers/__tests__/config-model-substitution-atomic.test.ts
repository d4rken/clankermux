/**
 * A rejected update must write nothing.
 *
 * Kept apart from the rest of the substitution-settings suite because it is the
 * one assertion about what does NOT happen on the failure path: a body carrying
 * a valid exception list and an invalid mode used to persist the list and then
 * answer 400, so the operator's next read disagreed with the error they had
 * just been shown.
 */
import { describe, expect, it, mock } from "bun:test";
import { createConfigHandlers } from "../config";

function makeConfig() {
	return {
		getServedModelSubstitutionMode: () => "enforce" as const,
		setServedModelSubstitutionMode: mock(() => {}),
		getServedModelSubstitutionExceptions: () => [],
		setServedModelSubstitutionExceptions: mock(() => {}),
	} as unknown as import("@clankermux/config").Config;
}

describe("model-substitution settings are written all-or-nothing", () => {
	it("does not save the exception list when the mode is invalid", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setServedModelSubstitutionMode(
			new Request("http://localhost/api/config/model-substitution", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "nonsense",
					exceptions: ["gpt-5.6-luna>gpt-6-luna"],
				}),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setServedModelSubstitutionExceptions).not.toHaveBeenCalled();
		expect(config.setServedModelSubstitutionMode).not.toHaveBeenCalled();
	});

	it("does not change the mode when an exception is invalid", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await handlers.setServedModelSubstitutionMode(
			new Request("http://localhost/api/config/model-substitution", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "observe", exceptions: ["*>*"] }),
			}),
		);

		expect(response.status).toBe(400);
		expect(config.setServedModelSubstitutionMode).not.toHaveBeenCalled();
	});
});
