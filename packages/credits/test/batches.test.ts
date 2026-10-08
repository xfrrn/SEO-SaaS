import { getTestInstance } from "better-auth/test";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCreditsService, credits } from "../src";
import { creditsClient } from "../src/client";

const testWith =
	process.env.CREDITS_TEST_DB === "postgres" ? "postgres" : "sqlite";
async function setup() {
	const instance = await getTestInstance(
		{ plugins: [credits()] },
		{ testWith, clientOptions: { plugins: [creditsClient()] } },
	);
	const { user, headers } = await instance.signInWithTestUser();
	const { adapter } = await instance.auth.$context;
	return {
		...instance,
		adapter,
		user,
		headers,
		service: createCreditsService(adapter),
	};
}

afterEach(() => vi.useRealTimers());

describe("credit batches", () => {
	it("spends earliest-expiring grants before permanent credits and recovers only the requested batch", async () => {
		const { service, user } = await setup();
		const referenceId = user.id;
		const now = Date.now();
		await service.grant({
			referenceId,
			amount: 50,
			idempotencyKey: "purchased",
			source: "purchase",
		});
		await service.grant({
			referenceId,
			amount: 50,
			idempotencyKey: "later",
			source: "membership",
			expiresAt: new Date(now + 60_000),
		});
		await service.grant({
			referenceId,
			amount: 50,
			idempotencyKey: "sooner",
			source: "membership",
			expiresAt: new Date(now + 30_000),
		});
		await service.consume({ referenceId, amount: 70, idempotencyKey: "usage" });
		expect(
			await service.revokeGrant({
				referenceId,
				grantKey: "sooner",
				idempotencyKey: "refund-sooner",
			}),
		).toMatchObject({ recovered: 0, unavailable: 50 });
		const body = {
			referenceId,
			grantKey: "later",
			idempotencyKey: "refund-later",
			reason: "Refund confirmed",
		};
		const refund = await service.revokeGrant(body);
		expect(refund).toMatchObject({
			recovered: 30,
			unavailable: 20,
			applied: true,
			entry: { kind: "revoke", amount: -30 },
		});
		expect(await service.revokeGrant(body)).toEqual({
			...refund,
			applied: false,
		});
		expect(await service.balance(referenceId)).toEqual({
			referenceId,
			balance: 50,
		});
		expect(
			await service.revokeGrant({ ...body, idempotencyKey: "second-refund" }),
		).toMatchObject({ recovered: 0, unavailable: 50 });
		expect((await service.balance(referenceId)).balance).toBe(50);
	});

	it("expires the remaining amount exactly at the boundary once under concurrent reads and rejects spending it", async () => {
		const { service, auth, user, headers } = await setup();
		vi.useFakeTimers({ toFake: ["Date"] });
		const now = new Date();
		vi.setSystemTime(now);
		const referenceId = user.id;
		await service.grant({
			referenceId,
			amount: 100,
			idempotencyKey: "monthly",
			expiresAt: new Date(now.getTime() + 1000),
		});
		await service.grant({ referenceId, amount: 40, idempotencyKey: "topup" });
		await service.consume({ referenceId, amount: 30, idempotencyKey: "usage" });
		vi.setSystemTime(now.getTime() + 999);
		expect((await service.balance(referenceId)).balance).toBe(110);
		vi.setSystemTime(now.getTime() + 1000);
		const results = await Promise.all(
			Array.from({ length: 6 }, () => auth.api.getCreditsBalance({ headers })),
		);
		expect(results.every((result) => result.balance === 40)).toBe(true);
		await expect(
			service.consume({ referenceId, amount: 41, idempotencyKey: "too-much" }),
		).rejects.toMatchObject({ body: { code: "INSUFFICIENT_CREDITS" } });
		const { entries } = await auth.api.listCreditsLedger({ headers });
		expect(entries.filter((entry) => entry.kind === "expire")).toEqual([
			expect.objectContaining({ amount: -70, balance: 40, sequence: 4 }),
		]);
		for (const entry of entries) {
			expect(entry).not.toHaveProperty("batchState");
			expect(entry).not.toHaveProperty("idempotencyKey");
			expect(entry).not.toHaveProperty("revokedGrantKey");
		}
		expect(
			await service.revokeGrant({
				referenceId,
				grantKey: "monthly",
				idempotencyKey: "refund",
			}),
		).toMatchObject({ recovered: 0, unavailable: 100 });
		expect((await service.balance(referenceId)).balance).toBe(40);
	});

	it("accepts delayed grants with a past expiry without making them spendable", async () => {
		const { service, user } = await setup();
		const body = {
			referenceId: user.id,
			amount: 100,
			idempotencyKey: "delayed-payment",
			expiresAt: new Date("2000-01-01T00:00:00Z"),
		};
		const grant = await service.grant(body);
		expect(grant.applied).toBe(true);
		expect((await service.balance(user.id)).balance).toBe(0);
		expect(await service.grant(body)).toEqual({ ...grant, applied: false });
		expect(
			(await service.ledger({ referenceId: user.id })).entries,
		).toHaveLength(2);
		await expect(
			service.consume({
				referenceId: user.id,
				amount: 1,
				idempotencyKey: "usage",
			}),
		).rejects.toMatchObject({ body: { code: "INSUFFICIENT_CREDITS" } });
	});

	it("migrates legacy permanent grants without changing their rows and preserves original grant recovery", async () => {
		const { adapter, service, user } = await setup();
		const referenceId = user.id;
		for (const row of [
			{ amount: 100, balance: 100, sequence: 1, idempotencyKey: "old-grant" },
			{ amount: -30, balance: 70, sequence: 2, idempotencyKey: "old-usage" },
			{ amount: 40, balance: 110, sequence: 3, idempotencyKey: "old-topup" },
		])
			await adapter.create({
				model: "creditEntry",
				data: { ...row, referenceId, createdAt: new Date() },
			});
		const before = await adapter.findMany({
			model: "creditEntry",
			sortBy: { field: "sequence", direction: "asc" },
		});
		expect(
			await service.revokeGrant({
				referenceId,
				grantKey: "old-grant",
				idempotencyKey: "legacy-refund",
			}),
		).toMatchObject({ recovered: 70, unavailable: 30 });
		expect((await service.balance(referenceId)).balance).toBe(40);
		const after = await adapter.findMany({
			model: "creditEntry",
			sortBy: { field: "sequence", direction: "asc" },
		});
		expect(after.slice(0, 3)).toEqual(before);
		await service.consume({
			referenceId,
			amount: 40,
			idempotencyKey: "new-usage",
		});
		expect((await service.balance(referenceId)).balance).toBe(0);
	});

	it("serializes racing refunds without recovering a grant more than once or touching a different grant", async () => {
		const { service, user } = await setup();
		const referenceId = user.id;
		await service.grant({ referenceId, amount: 80, idempotencyKey: "invoice" });
		await service.grant({ referenceId, amount: 40, idempotencyKey: "other" });
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				service.revokeGrant({
					referenceId,
					grantKey: "invoice",
					idempotencyKey: `refund-${index}`,
				}),
			),
		);
		expect(results.reduce((sum, result) => sum + result.recovered, 0)).toBe(80);
		expect((await service.balance(referenceId)).balance).toBe(40);
		const { entries } = await service.ledger({ referenceId });
		expect(entries.every((entry) => entry.balance >= 0)).toBe(true);
		expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(40);
	});

	it("does not partially change a batch on failed writes and recovers uncertain committed revocations", async () => {
		const { adapter, service, user } = await setup();
		const referenceId = user.id;
		await service.grant({ referenceId, amount: 40, idempotencyKey: "invoice" });
		const body = { referenceId, grantKey: "invoice", idempotencyKey: "refund" };
		const create = adapter.create.bind(adapter);
		vi.spyOn(adapter, "create").mockRejectedValueOnce(
			new Error("storage down"),
		);
		await expect(service.revokeGrant(body)).rejects.toThrow("storage down");
		expect((await service.balance(referenceId)).balance).toBe(40);
		vi.spyOn(adapter, "create").mockImplementationOnce(async (args) => {
			await create(args);
			throw new Error("connection lost after commit");
		});
		expect(await service.revokeGrant(body)).toMatchObject({
			recovered: 40,
			unavailable: 0,
		});
		expect(await service.revokeGrant(body)).toMatchObject({
			recovered: 40,
			applied: false,
		});
		expect((await service.balance(referenceId)).balance).toBe(0);
		expect((await service.ledger({ referenceId })).entries).toHaveLength(2);
	});

	it("serializes consumption racing a refund without recovering spent credits or overdrawing", async () => {
		const { service, user } = await setup();
		const referenceId = user.id;
		await service.grant({
			referenceId,
			amount: 100,
			idempotencyKey: "invoice",
		});
		await service.grant({ referenceId, amount: 100, idempotencyKey: "other" });
		const [refund] = await Promise.all([
			service.revokeGrant({
				referenceId,
				grantKey: "invoice",
				idempotencyKey: "refund",
			}),
			service.consume({ referenceId, amount: 50, idempotencyKey: "usage" }),
		]);
		expect([50, 100]).toContain(refund.recovered);
		expect(refund.recovered + refund.unavailable).toBe(100);
		expect((await service.balance(referenceId)).balance).toBe(
			150 - refund.recovered,
		);
		const { entries } = await service.ledger({ referenceId });
		expect(entries.map((entry) => entry.sequence)).toEqual([4, 3, 2, 1]);
		expect(entries.every((entry) => entry.balance >= 0)).toBe(true);
	});

	it("keeps expiration retryable after storage failure without exposing expired credits", async () => {
		const { service, adapter, user } = await setup();
		const referenceId = user.id;
		await service.grant({
			referenceId,
			amount: 100,
			idempotencyKey: "old",
			expiresAt: new Date(0),
		});
		vi.spyOn(adapter, "create").mockRejectedValueOnce(
			new Error("storage down"),
		);
		await expect(service.balance(referenceId)).rejects.toThrow("storage down");
		expect(await adapter.count({ model: "creditEntry" })).toBe(1);
		await expect(
			service.consume({ referenceId, amount: 1, idempotencyKey: "usage" }),
		).rejects.toMatchObject({ body: { code: "INSUFFICIENT_CREDITS" } });
		expect((await service.balance(referenceId)).balance).toBe(0);
		expect((await service.ledger({ referenceId })).entries).toHaveLength(2);
	});

	it("validates direct service inputs and includes source, expiry, and grant identity in idempotency checks", async () => {
		const { service, user, client } = await setup();
		const referenceId = user.id;
		const body = {
			referenceId,
			amount: 50,
			idempotencyKey: "invoice",
			source: "purchase",
			expiresAt: new Date(Date.now() + 60_000),
		};
		await service.grant(body);
		for (const changed of [
			{ ...body, source: "membership" },
			{ ...body, expiresAt: new Date(body.expiresAt.getTime() + 1) },
			{ ...body, expiresAt: undefined },
		])
			await expect(service.grant(changed)).rejects.toMatchObject({
				body: { code: "CREDITS_IDEMPOTENCY_CONFLICT" },
			});
		await expect(service.grant({ ...body, amount: 0 })).rejects.toBeDefined();
		await expect(
			service.grant({ ...body, expiresAt: new Date(NaN) }),
		).rejects.toBeDefined();
		await expect(
			service.grant({ ...body, idempotencyKey: " credits:expiry:1" }),
		).rejects.toBeDefined();
		await expect(
			service.revokeGrant({
				referenceId,
				grantKey: "missing",
				idempotencyKey: "refund",
			}),
		).rejects.toMatchObject({ body: { code: "CREDITS_GRANT_NOT_FOUND" } });
		await service.revokeGrant({
			referenceId,
			grantKey: "invoice",
			idempotencyKey: "refund",
		});
		await expect(
			service.revokeGrant({
				referenceId,
				grantKey: "other",
				idempotencyKey: "refund",
			}),
		).rejects.toMatchObject({ body: { code: "CREDITS_IDEMPOTENCY_CONFLICT" } });
		expectTypeOf<"revokeCreditsGrant">().not.toExtend<keyof typeof client>();
	});
});
