/**
 * `/api/config/model-substitution` — the mode and the accepted-swap list.
 *
 * The list travels with the mode because it only means anything relative to it:
 * "accepted" is a statement about what enforcement skips.
 */
import { describe, expect, it, mock } from "bun:test";
import { createConfigHandlers } from "../config";

function makeConfig(initial: string[] = []) {
	let mode: "off" | "observe" | "enforce" = "enforce";
	let exceptions = [...initial];
	return {
		getServedModelSubstitutionMode: () => mode,
		setServedModelSubstitutionMode: mock((v: typeof mode) => {
			mode = v;
		}),
		getServedModelSubstitutionExceptions: () => exceptions,
		setServedModelSubstitutionExceptions: mock((v: readonly string[]) => {
			exceptions = v.map((entry) => entry.trim().toLowerCase());
		}),
	} as unknown as import("@clankermux/config").Config;
}

function post(
	handlers: ReturnType<typeof createConfigHandlers>,
	body: unknown,
): Promise<Response> {
	return handlers.setServedModelSubstitutionMode(
		new Request("http://localhost/api/config/model-substitution", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("model-substitution settings", () => {
	it("returns the mode and the accepted swaps together", async () => {
		const handlers = createConfigHandlers(
			makeConfig(["gpt-5.6-luna>gpt-6-luna"]),
			{ port: 8080, tlsEnabled: false },
		);

		const body = await handlers.getServedModelSubstitutionMode().json();

		expect(body.servedModelSubstitutionMode).toBe("enforce");
		expect(body.servedModelSubstitutionExceptions).toEqual([
			"gpt-5.6-luna>gpt-6-luna",
		]);
	});

	it("saves a list without being sent a mode", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, {
			exceptions: ["gpt-5.6-luna>gpt-6-luna"],
		});

		expect(response.status).toBe(200);
		expect(config.setServedModelSubstitutionExceptions).toHaveBeenCalled();
		// An exceptions-only edit must not be read as a request to change the mode.
		expect(config.setServedModelSubstitutionMode).not.toHaveBeenCalled();
	});

	// Silently dropping an unparseable rule would leave an operator looking at a
	// list that lost the line they just typed, with no reason given.
	it("rejects a rule with no served side instead of dropping it", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, { exceptions: ["gpt-5.6-luna"] });

		expect(response.status).toBe(400);
		expect(await response.text()).toContain("gpt-5.6-luna");
		expect(config.setServedModelSubstitutionExceptions).not.toHaveBeenCalled();
	});

	it("rejects a rule that would accept everything", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, { exceptions: ["*>*"] });

		expect(response.status).toBe(400);
		expect(config.setServedModelSubstitutionExceptions).not.toHaveBeenCalled();
	});

	it("rejects a non-array exceptions field", async () => {
		const handlers = createConfigHandlers(makeConfig(), {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, { exceptions: "a>b" });

		expect(response.status).toBe(400);
	});

	it("accepts a one-sided wildcard", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, { exceptions: ["gpt-6-astra>*"] });

		expect(response.status).toBe(200);
		expect(config.setServedModelSubstitutionExceptions).toHaveBeenCalledWith([
			"gpt-6-astra>*",
		]);
	});

	it("clears the list when sent an empty array", async () => {
		const config = makeConfig(["gpt-5.6-luna>gpt-6-luna"]);
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, { exceptions: [] });

		expect(response.status).toBe(200);
		expect(config.setServedModelSubstitutionExceptions).toHaveBeenCalledWith(
			[],
		);
	});

	it("still validates the mode when both are sent", async () => {
		const config = makeConfig();
		const handlers = createConfigHandlers(config, {
			port: 8080,
			tlsEnabled: false,
		});

		const response = await post(handlers, {
			mode: "nonsense",
			exceptions: ["gpt-5.6-luna>gpt-6-luna"],
		});

		expect(response.status).toBe(400);
		expect(config.setServedModelSubstitutionMode).not.toHaveBeenCalled();
	});
});
