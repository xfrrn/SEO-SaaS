import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { createCreditsService, credits, withCreditsTransaction } from "../src";

async function setup() {
	const instance = await getTestInstance(
		{
			plugins: [
				credits(),
				{
					id: "media-test",
					schema: {
						mediaTest: {
							fields: { requestId: { type: "string", required: true } },
							indexes: [{ fields: ["requestId"], unique: true }],
						},
					},
				},
			],
		},
		{ testWith: "sqlite" },
	);
	const { user } = await instance.signInWithTestUser();
	const { adapter } = await instance.auth.$context;
	const service = createCreditsService(adapter);
	await service.grant({
		referenceId: user.id,
		amount: 100,
		idempotencyKey: "purchase",
	});
	return { adapter, service, referenceId: user.id };
}
describe("permanent credit reservations", () => {
	it("queries original reservation amounts and finalization without exposing another account", async () => {
		const { service, referenceId } = await setup();
		expect(await service.reservation(referenceId, "missing")).toBeNull();
		expect(await service.reservation(referenceId, "purchase")).toBeNull();
		await service.reserve({
			referenceId,
			amount: 20,
			idempotencyKey: "delivered",
		});
		await service.reserve({
			referenceId,
			amount: 30,
			idempotencyKey: "cancelled",
		});
		expect(await service.reservation(referenceId, "delivered")).toMatchObject({
			amount: 20,
			status: "held",
		});
		expect(
			await service.reservation("another-account", "delivered"),
		).toBeNull();
		await service.consume({
			referenceId,
			amount: 1,
			idempotencyKey: "ordinary",
		});
		await service.settle({
			referenceId,
			reservationId: "delivered",
			idempotencyKey: "settle",
		});
		await service.release({
			referenceId,
			reservationId: "cancelled",
			idempotencyKey: "release",
		});
		expect(await service.reservation(referenceId, "delivered")).toMatchObject({
			amount: 20,
			status: "settled",
		});
		expect(await service.reservation(referenceId, "cancelled")).toMatchObject({
			amount: 30,
			status: "released",
		});
		expect((await service.ledger({ referenceId })).entries).toHaveLength(6);
		expect((await service.account(referenceId)).total).toBe(79);
	});
	it("reserves once, protects ordinary consumption and settles exactly once", async () => {
		const { service, referenceId } = await setup();
		const reserve = { referenceId, amount: 70, idempotencyKey: "business-1" };
		expect((await service.reserve(reserve)).applied).toBe(true);
		expect((await service.reserve(reserve)).applied).toBe(false);
		expect(await service.account(referenceId)).toMatchObject({
			total: 100,
			reserved: 70,
			available: 30,
		});
		await expect(
			service.consume({ referenceId, amount: 31, idempotencyKey: "other" }),
		).rejects.toMatchObject({ body: { code: "INSUFFICIENT_CREDITS" } });
		await service.consume({ referenceId, amount: 30, idempotencyKey: "other" });
		const settle = {
			referenceId,
			reservationId: "business-1",
			idempotencyKey: "settle-1",
		};
		expect((await service.settle(settle)).entry).toMatchObject({
			amount: -70,
			balance: 0,
			kind: "settle",
		});
		expect((await service.settle(settle)).applied).toBe(false);
		await expect(
			service.release({ ...settle, idempotencyKey: "late-release" }),
		).rejects.toMatchObject({
			body: { code: "CREDITS_RESERVATION_FINALIZED_OR_MISSING" },
		});
	});
	it("release does not create credits and cannot be reversed by a late success", async () => {
		const { service, referenceId } = await setup();
		await service.reserve({
			referenceId,
			amount: 80,
			idempotencyKey: "business",
		});
		const final = {
			referenceId,
			reservationId: "business",
			idempotencyKey: "released",
		};
		await service.release(final);
		expect((await service.release(final)).applied).toBe(false);
		expect(await service.account(referenceId)).toMatchObject({
			total: 100,
			reserved: 0,
			available: 100,
		});
		await expect(
			service.settle({ ...final, idempotencyKey: "late-success" }),
		).rejects.toThrow();
	});
	it("grant recovery protects held batches; expiring credits are never frozen", async () => {
		const { service, referenceId } = await setup();
		await service.reserve({
			referenceId,
			amount: 70,
			idempotencyKey: "business",
		});
		expect(
			(
				await service.revokeGrant({
					referenceId,
					grantKey: "purchase",
					idempotencyKey: "revoke",
				})
			).recovered,
		).toBe(30);
		await service.grant({
			referenceId,
			amount: 100,
			idempotencyKey: "expiring",
			expiresAt: new Date(Date.now() + 60000),
		});
		await expect(
			service.reserve({ referenceId, amount: 1, idempotencyKey: "business-2" }),
		).rejects.toMatchObject({
			body: { code: "INSUFFICIENT_PERMANENT_CREDITS" },
		});
		await service.consume({
			referenceId,
			amount: 100,
			idempotencyKey: "use-expiring",
		});
		await service.settle({
			referenceId,
			reservationId: "business",
			idempotencyKey: "settle",
		});
		expect((await service.balance(referenceId)).balance).toBe(0);
	});
	it("concurrent reservations cannot overspend the authoritative ledger", async () => {
		const { service, referenceId } = await setup();
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, index) =>
				service.reserve({
					referenceId,
					amount: 30,
					idempotencyKey: `business-${index}`,
				}),
			),
		);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(3);
		expect(await service.account(referenceId)).toMatchObject({
			total: 100,
			reserved: 90,
			available: 10,
		});
	});
	it("host business writes and reservation rollback together in one real transaction", async () => {
		const { service, referenceId, adapter } = await setup();
		expect(adapter.options?.adapterConfig.transaction).toBeTruthy();
		await expect(
			withCreditsTransaction(adapter, async (tx, transactionCredits) => {
				await transactionCredits.reserve({
					referenceId,
					amount: 60,
					idempotencyKey: "atomic-request",
				});
				await tx.create({
					model: "mediaTest",
					data: { requestId: "atomic-request" },
				});
				throw new Error("host-write-failed");
			}),
		).rejects.toThrow("host-write-failed");
		expect(await service.account(referenceId)).toMatchObject({
			total: 100,
			reserved: 0,
			available: 100,
		});
		expect(await adapter.count({ model: "mediaTest" })).toBe(0);
		await withCreditsTransaction(adapter, async (tx, transactionCredits) => {
			await transactionCredits.reserve({
				referenceId,
				amount: 60,
				idempotencyKey: "atomic-request",
			});
			await tx.create({
				model: "mediaTest",
				data: { requestId: "atomic-request" },
			});
		});
		expect((await service.account(referenceId)).reserved).toBe(60);
		expect(await adapter.count({ model: "mediaTest" })).toBe(1);
	});
	it("rejects adapters without real transactions and serializes competing finalizations", async () => {
		const { service, referenceId, adapter } = await setup();
		const unsupported = {
			...adapter,
			options: {
				...adapter.options,
				adapterConfig: {
					...adapter.options!.adapterConfig,
					transaction: false as const,
				},
			},
		};
		await expect(
			createCreditsService(unsupported).reserve({
				referenceId,
				amount: 10,
				idempotencyKey: "unsupported",
			}),
		).rejects.toMatchObject({
			body: { code: "CREDITS_TRANSACTIONS_REQUIRED" },
		});
		await service.reserve({
			referenceId,
			amount: 60,
			idempotencyKey: "competing",
		});
		const results = await Promise.allSettled([
			service.settle({
				referenceId,
				reservationId: "competing",
				idempotencyKey: "settle-competing",
			}),
			service.release({
				referenceId,
				reservationId: "competing",
				idempotencyKey: "release-competing",
			}),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect((await service.account(referenceId)).reserved).toBe(0);
		const { entries } = await service.ledger({ referenceId });
		expect(
			entries.filter(
				(entry) => entry.kind === "settle" || entry.kind === "release",
			),
		).toHaveLength(1);
	});
});
