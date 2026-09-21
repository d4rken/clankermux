/**
 * Accepting a swap has to release the suppression that swap already caused.
 *
 * Enforcement holds an (account, model) pair back for five minutes. Accept that
 * pair and the dashboard stops calling the account degraded immediately, while
 * routing would keep excluding it for the rest of the window — the operator
 * sees the swap marked accepted and still watches requests fail over around it,
 * or get a 503 if nothing else can serve them.
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

function makeRouting() {
	return {
		clearModelSuppressionsByReason: mock(async () => {}),
	};
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

describe("changing the accepted swaps releases substitution suppressions", () => {
	it("releases when a swap is added", async () => {
		const routing = makeRouting();
		const handlers = createConfigHandlers(
			makeConfig(),
			{ port: 8080, tlsEnabled: false },
			routing,
		);

		await post(handlers, { exceptions: ["gpt-5.6-luna>gpt-6-luna"] });

		expect(routing.clearModelSuppressionsByReason).toHaveBeenCalledWith(
			"upstream_model_substituted",
		);
	});

	// Removing one matters as much as adding: the pair goes back to being
	// enforced, and a stale row is the wrong state in the other direction.
	it("releases when a swap is removed", async () => {
		const routing = makeRouting();
		const handlers = createConfigHandlers(
			makeConfig(["gpt-5.6-luna>gpt-6-luna"]),
			{ port: 8080, tlsEnabled: false },
			routing,
		);

		await post(handlers, { exceptions: [] });

		expect(routing.clearModelSuppressionsByReason).toHaveBeenCalled();
	});

	// Saving the same list is not a change. Clearing on every save would let a
	// dashboard that re-saves on load defeat the five-minute hold entirely.
	it("does not release when the list is unchanged", async () => {
		const routing = makeRouting();
		const handlers = createConfigHandlers(
			makeConfig(["gpt-5.6-luna>gpt-6-luna"]),
			{ port: 8080, tlsEnabled: false },
			routing,
		);

		await post(handlers, { exceptions: ["gpt-5.6-luna>gpt-6-luna"] });

		expect(routing.clearModelSuppressionsByReason).not.toHaveBeenCalled();
	});

	// Trimming and lowercasing happen on the way in, so a differently-typed but
	// identical rule is not a change either.
	it("does not release for a cosmetic difference", async () => {
		const routing = makeRouting();
		const handlers = createConfigHandlers(
			makeConfig(["gpt-5.6-luna>gpt-6-luna"]),
			{ port: 8080, tlsEnabled: false },
			routing,
		);

		await post(handlers, { exceptions: ["  GPT-5.6-Luna>GPT-6-Luna  "] });

		expect(routing.clearModelSuppressionsByReason).not.toHaveBeenCalled();
	});

	it("still releases when the mode leaves enforce", async () => {
		const routing = makeRouting();
		const handlers = createConfigHandlers(
			makeConfig(),
			{ port: 8080, tlsEnabled: false },
			routing,
		);

		await post(handlers, { mode: "observe" });

		expect(routing.clearModelSuppressionsByReason).toHaveBeenCalled();
	});

	it("does not release when the mode stays enforce and nothing else changed", async () => {
		const routing = makeRouting();
		const handlers = createConfigHandlers(
			makeConfig(),
			{ port: 8080, tlsEnabled: false },
			routing,
		);

		await post(handlers, { mode: "enforce" });

		expect(routing.clearModelSuppressionsByReason).not.toHaveBeenCalled();
	});
});
