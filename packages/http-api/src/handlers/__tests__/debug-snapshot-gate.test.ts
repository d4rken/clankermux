/**
 * `GET /api/debug/snapshot` dumps the process heap, which can hold the setup
 * code and other secrets, and the management API is open while no password is
 * set. So the snapshot is refused until one is.
 */
import { describe, expect, it } from "bun:test";
import { createGatedHeapSnapshotHandler } from "../debug";

describe("the heap snapshot gate", () => {
	it("answers 403 without taking a snapshot while no password is set", async () => {
		let snapshots = 0;
		const handler = createGatedHeapSnapshotHandler(
			async () => false,
			() => {
				snapshots++;
				return new Response("heap");
			},
		);
		const res = await handler();
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Heap snapshots are disabled until a management password is set",
		});
		expect(snapshots).toBe(0);
	});

	it("takes the snapshot once a password is set", async () => {
		let snapshots = 0;
		const handler = createGatedHeapSnapshotHandler(
			async () => true,
			() => {
				snapshots++;
				return new Response("heap");
			},
		);
		const res = await handler();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("heap");
		expect(snapshots).toBe(1);
	});
});
