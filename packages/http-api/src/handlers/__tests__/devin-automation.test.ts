import { describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@clankermux/database";
import {
	createAccountAutoFallbackHandler,
	createAccountAutoRefreshHandler,
} from "../accounts";

describe("Devin automation controls", () => {
	it("waits for the persisted recovery setting before reporting success", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const db = {
			getAdapter: () => ({
				get: async () => ({ name: "Devin", provider: "devin" }),
			}),
			setAutoFallbackEnabled: () => pending,
		} as unknown as DatabaseOperations;
		let settled = false;
		const result = createAccountAutoFallbackHandler(db)(
			new Request("http://localhost/automation", {
				method: "POST",
				body: '{"enabled":1}',
			}),
			"devin",
		).then((response) => {
			settled = true;
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		release();
		expect((await result).status).toBe(200);
	});
	it("reports failure when persisting recovery settings fails", async () => {
		const db = {
			getAdapter: () => ({
				get: async () => ({ name: "Devin", provider: "devin" }),
			}),
			setAutoFallbackEnabled: async () => {
				throw new Error("database write failed");
			},
		} as unknown as DatabaseOperations;
		const result = await createAccountAutoFallbackHandler(db)(
			new Request("http://localhost/automation", {
				method: "POST",
				body: '{"enabled":1}',
			}),
			"devin",
		);
		expect(result.status).toBe(500);
	});
	it("accepts explicit quota recovery opt-in without enabling inference warmups", async () => {
		const setAutoFallbackEnabled = mock(async () => {});
		const db = {
			getAdapter: () => ({
				get: async () => ({ name: "Devin", provider: "devin" }),
			}),
			setAutoFallbackEnabled,
		} as unknown as DatabaseOperations;
		const request = () =>
			new Request("http://localhost/automation", {
				method: "POST",
				body: JSON.stringify({ enabled: 1 }),
				headers: { "content-type": "application/json" },
			});
		const recovery = await createAccountAutoFallbackHandler(db)(
			request(),
			"devin",
		);
		expect(recovery.status).toBe(200);
		expect(setAutoFallbackEnabled).toHaveBeenCalledWith("devin", true);
		const warmup = await createAccountAutoRefreshHandler(db)(
			request(),
			"devin",
		);
		expect(warmup.status).toBe(400);
	});
});
