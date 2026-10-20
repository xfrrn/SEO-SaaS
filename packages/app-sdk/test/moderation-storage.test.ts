import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { moderationSchema } from "../src/moderation/schema";
import { createModerationStore } from "../src/moderation/storage";
import type { RecordInput } from "../src/moderation/types";

async function setup() {
	const instance = await getTestInstance(
		{ plugins: [{ id: "moderation-storage-test", schema: moderationSchema }] },
		{ transaction: true },
	);
	const { adapter } = await instance.auth.$context;
	return { adapter, store: createModerationStore(adapter) };
}
function input(key: string, value = 1): RecordInput<{ value: number }> {
	return {
		kind: "attempt",
		key,
		subject_id: "subject",
		attempt_id: "attempt",
		data: { value },
	};
}

describe("moderation SQL storage", () => {
	it("requires advertised real transactions rather than a transaction-shaped method", async () => {
		const { adapter } = await setup();
		expect(() => createModerationStore({ ...adapter, id: "memory" })).toThrow();
		expect(() =>
			createModerationStore({ ...adapter, options: undefined }),
		).toThrow();
		expect(() =>
			createModerationStore({
				...adapter,
				options: {
					...adapter.options,
					adapterConfig: { adapterId: "no-transactions", transaction: false },
				},
			}),
		).toThrow();
	});

	it("commits complete writes and rolls back partial work", async () => {
		const { store } = await setup();
		await expect(
			store.transaction("one", async (tx) => {
				await tx.insert(input("rolled-back"));
				throw new Error("stop");
			}),
		).rejects.toThrow("stop");
		expect(await store.get("one", "attempt", "rolled-back")).toBeNull();
		const saved = await store.transaction("one", (tx) =>
			tx.insert(input("committed")),
		);
		expect(saved.revision).toBe(0);
		expect(saved.created_at).toBe(new Date(saved.created_at).toISOString());
		expect(await store.get("one", "attempt", "committed")).toEqual(saved);
	});

	it("enforces tenant boundaries for reads, lists, replacements and deletion", async () => {
		const { store } = await setup();
		const first = await store.transaction("one", (tx) =>
			tx.insert(input("shared")),
		);
		const second = await store.transaction("two", (tx) =>
			tx.insert(input("shared", 2)),
		);
		expect(await store.get("three", "attempt", "shared")).toBeNull();
		expect(await store.list("one", "attempt", { limit: 10 })).toEqual([first]);
		await expect(
			store.transaction("two", (tx) => tx.replace(first, { value: 3 })),
		).rejects.toMatchObject({ body: { code: "FORBIDDEN" } });
		await store.transaction("three", (tx) => tx.remove("attempt", "shared"));
		expect(await store.get("two", "attempt", "shared")).toEqual(second);
		await store.transaction("one", (tx) => tx.remove("attempt", "shared"));
		expect(await store.get("one", "attempt", "shared")).toBeNull();
		expect(await store.get("two", "attempt", "shared")).toEqual(second);
	});

	it("replays identical inserts and rejects conflicting or physically duplicated keys", async () => {
		const { adapter, store } = await setup();
		const saved = await store.transaction("one", (tx) =>
			tx.insert(input("key")),
		);
		expect(
			await store.transaction("one", (tx) => tx.insert(input("key"))),
		).toEqual(saved);
		await expect(
			store.transaction("one", (tx) => tx.insert(input("key", 2))),
		).rejects.toMatchObject({ body: { code: "IDEMPOTENCY_CONFLICT" } });
		await expect(
			adapter.create({
				model: "moderationRecord",
				data: {
					tenantId: "one",
					kind: "attempt",
					recordKey: "key",
					payload: "{}",
					revision: 0,
					createdAt: new Date(),
				},
			}),
		).rejects.toThrow();
		expect(await store.get("one", "attempt", "key")).toEqual(saved);
	});

	it("prevents evidence replacement and rejects stale revisions atomically", async () => {
		const { store } = await setup();
		const saved = await store.transaction("one", (tx) =>
			tx.insert(input("attempt")),
		);
		const updated = await store.transaction("one", (tx) =>
			tx.replace(saved, { value: 2 }),
		);
		expect(updated.revision).toBe(1);
		expect(updated.created_at).toBe(saved.created_at);
		await expect(
			store.transaction("one", (tx) => tx.replace(saved, { value: 3 })),
		).rejects.toMatchObject({ body: { code: "STATE_CONFLICT" } });
		const report = await store.transaction("one", (tx) =>
			tx.insert({ ...input("evidence"), kind: "report" }),
		);
		await expect(
			store.transaction("one", (tx) => tx.replace(report, { value: 2 })),
		).rejects.toMatchObject({ body: { code: "IMMUTABLE_RECORD" } });
		expect(await store.get("one", "attempt", "attempt")).toEqual(updated);
	});

	it("serializes competing tenant writes and permits exactly one revision winner", async () => {
		const { store } = await setup();
		const [first, replay] = await Promise.all([
			store.transaction("new-tenant", (tx) => tx.insert(input("race"))),
			store.transaction("new-tenant", (tx) => tx.insert(input("race"))),
		]);
		expect(first).toEqual(replay);
		const results = await Promise.allSettled([
			store.transaction("new-tenant", (tx) => tx.replace(first, { value: 2 })),
			store.transaction("new-tenant", (tx) => tx.replace(first, { value: 3 })),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
			body: { code: "STATE_CONFLICT" },
		});
	});

	it("paginates by key with SQL date and ownership filters inside and outside transactions", async () => {
		const { adapter, store } = await setup();
		await store.transaction("one", async (tx) => {
			for (const key of ["c", "a", "b"]) await tx.insert(input(key));
			await tx.insert({ ...input("d"), subject_id: "other" });
		});
		await adapter.updateMany({
			model: "moderationRecord",
			where: [{ field: "recordKey", value: "c" }],
			update: { createdAt: new Date("2030-01-01T00:00:00.000Z") },
		});
		expect(
			(await store.list("one", "attempt", { limit: 1 })).map((row) => row.key),
		).toEqual(["a"]);
		const page = await store.transaction("one", (tx) =>
			tx.list("attempt", {
				limit: 10,
				after: "a",
				before: "2030-01-01T00:00:00.000Z",
				subject_id: "subject",
				attempt_id: "attempt",
			}),
		);
		expect(page.map((row) => row.key)).toEqual(["b"]);
		expect(
			(
				await store.list("one", "attempt", {
					limit: 10,
					since: "2030-01-01T00:00:00.000Z",
				})
			).map((row) => row.key),
		).toEqual(["c"]);
		for (const limit of [0, -1, 1.5, 1001, Infinity])
			await expect(store.list("one", "attempt", { limit })).rejects.toThrow();
		await expect(
			store.list("one", "attempt", { limit: 1, before: "2026-01-01" }),
		).rejects.toThrow();
	});

	it("stores canonical JSON and fails explicitly on corrupt payloads", async () => {
		const { adapter, store } = await setup();
		const data = { z: ["2026-10-20T00:00:00.000Z"], a: 1 };
		const saved = await store.transaction("one", (tx) =>
			tx.insert({ ...input("json"), data }),
		);
		const raw = await adapter.findOne<{ payload: string }>({
			model: "moderationRecord",
			where: [{ field: "id", value: saved.id }],
		});
		expect(raw?.payload).toBe('{"a":1,"z":["2026-10-20T00:00:00.000Z"]}');
		expect(saved.data).toEqual(data);
		await expect(
			store.transaction("one", (tx) =>
				tx.insert({ ...input("bad"), data: { value: Infinity } }),
			),
		).rejects.toThrow();
		for (const payload of ["broken", "[]", "null", '{"value":1e1000}']) {
			await adapter.updateMany({
				model: "moderationRecord",
				where: [{ field: "id", value: saved.id }],
				update: { payload },
			});
			await expect(store.get("one", "attempt", "json")).rejects.toMatchObject({
				body: { code: "INVALID_STORED_DATA" },
			});
		}
	});
});
