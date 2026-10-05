import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { credits } from "../src";
import { creditsClient } from "../src/client";
import { createCreditsSchema } from "../src/schema";

// Set CREDITS_TEST_DB=postgres to run the same invariants against PostgreSQL.
const testWith =
	process.env.CREDITS_TEST_DB === "postgres" ? "postgres" : "sqlite";
const setup = () =>
	getTestInstance(
		{ plugins: [credits()] },
		{ testWith, clientOptions: { plugins: [creditsClient()] } },
	);

describe("credits ledger", () => {
	it("starts at zero and records signed grants and consumption with resulting balances", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		expect(await auth.api.getCreditsBalance({ headers })).toEqual({
			referenceId: user.id,
			balance: 0,
		});
		expect(await auth.api.listCreditsLedger({ headers })).toEqual({
			entries: [],
			nextCursor: null,
		});
		const grant = await auth.api.grantCredits({
			body: {
				referenceId: user.id,
				amount: 100,
				idempotencyKey: "invoice-1",
				reason: "Monthly allowance",
			},
		});
		expect(grant).toMatchObject({
			applied: true,
			entry: { amount: 100, balance: 100, sequence: 1 },
		});
		const consume = await auth.api.consumeCredits({
			body: { referenceId: user.id, amount: 40, idempotencyKey: "job-1" },
		});
		expect(consume).toMatchObject({
			applied: true,
			entry: { amount: -40, balance: 60, sequence: 2 },
		});
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 60,
		});
		const ledger = await auth.api.listCreditsLedger({ headers });
		expect(
			ledger.entries.map(({ amount, balance }) => ({ amount, balance })),
		).toEqual([
			{ amount: -40, balance: 60 },
			{ amount: 100, balance: 100 },
		]);
		for (const entry of ledger.entries) {
			expect(entry).not.toHaveProperty("idempotencyKey");
			expect(entry.createdAt).toBeInstanceOf(Date);
		}
	});

	it("rejects insufficient funds without recording a debit and allows spending exactly the balance", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = { referenceId: user.id, amount: 10, idempotencyKey: "job" };
		await expect(auth.api.consumeCredits({ body })).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { code: "INSUFFICIENT_CREDITS" },
		});
		await auth.api.grantCredits({
			body: { ...body, idempotencyKey: "allowance" },
		});
		await expect(
			auth.api.consumeCredits({ body: { ...body, amount: 11 } }),
		).rejects.toBeDefined();
		expect((await auth.api.consumeCredits({ body })).applied).toBe(true);
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 0,
		});
		expect(
			(await auth.api.listCreditsLedger({ headers })).entries,
		).toHaveLength(2);
	});

	it("replays the original entry after later changes without crediting or consuming twice", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = {
			referenceId: user.id,
			amount: 100,
			idempotencyKey: "invoice",
			reason: "Paid invoice",
		};
		const first = await auth.api.grantCredits({ body });
		const debitBody = { ...body, amount: 80, idempotencyKey: "job" };
		const debit = await auth.api.consumeCredits({ body: debitBody });
		expect(await auth.api.grantCredits({ body })).toEqual({
			entry: first.entry,
			applied: false,
		});
		expect(await auth.api.consumeCredits({ body: debitBody })).toEqual({
			entry: debit.entry,
			applied: false,
		});
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 20,
		});
		expect(
			(await auth.api.listCreditsLedger({ headers })).entries,
		).toHaveLength(2);
	});

	it("rejects reusing an idempotency key with a changed amount, reason, or direction", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = {
			referenceId: user.id,
			amount: 100,
			idempotencyKey: "request",
			reason: "Original reason",
		};
		await auth.api.grantCredits({ body });
		for (const changed of [
			{ ...body, amount: 101 },
			{ ...body, reason: "Different reason" },
			{ ...body, reason: undefined },
		]) {
			await expect(
				auth.api.grantCredits({ body: changed }),
			).rejects.toMatchObject({
				status: "CONFLICT",
				body: { code: "CREDITS_IDEMPOTENCY_CONFLICT" },
			});
		}
		await expect(auth.api.consumeCredits({ body })).rejects.toMatchObject({
			status: "CONFLICT",
		});
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 100,
		});
	});

	it("scopes idempotency and balances to each reference", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = { referenceId: user.id, amount: 10, idempotencyKey: "same" };
		const own = await auth.api.grantCredits({ body });
		const other = await auth.api.grantCredits({
			body: { ...body, referenceId: "other-account", amount: 300 },
		});
		expect(other.applied).toBe(true);
		expect(other.entry.id).not.toBe(own.entry.id);
		expect(other.entry).toMatchObject({ balance: 300, sequence: 1 });
		await auth.api.consumeCredits({
			body: { ...body, amount: 7, idempotencyKey: "own-job" },
		});
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 3,
		});
		const { adapter } = await auth.$context;
		expect(
			await adapter.count({
				model: "creditEntry",
				where: [{ field: "referenceId", value: "other-account" }],
			}),
		).toBe(1);
	});

	it("deduplicates concurrent grants and concurrent consumption in SQL", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = { referenceId: user.id, amount: 100, idempotencyKey: "grant" };
		const grants = await Promise.all(
			Array.from({ length: 6 }, () => auth.api.grantCredits({ body })),
		);
		expect(grants.filter(({ applied }) => applied)).toHaveLength(1);
		expect(new Set(grants.map(({ entry }) => entry.id)).size).toBe(1);
		const spends = await Promise.all(
			Array.from({ length: 6 }, () =>
				auth.api.consumeCredits({
					body: { ...body, amount: 70, idempotencyKey: "consume" },
				}),
			),
		);
		expect(spends.filter(({ applied }) => applied)).toHaveLength(1);
		expect(new Set(spends.map(({ entry }) => entry.id)).size).toBe(1);
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 30,
		});
		expect(
			(await auth.api.listCreditsLedger({ headers })).entries,
		).toHaveLength(2);
	});

	it("serializes distinct concurrent debits without overspending", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		await auth.api.grantCredits({
			body: { referenceId: user.id, amount: 100, idempotencyKey: "grant" },
		});
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, index) =>
				auth.api.consumeCredits({
					body: {
						referenceId: user.id,
						amount: 30,
						idempotencyKey: `job-${index}`,
					},
				}),
			),
		);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
			3,
		);
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 10,
		});
		const { entries } = await auth.api.listCreditsLedger({ headers });
		expect(entries.map(({ sequence }) => sequence)).toEqual([4, 3, 2, 1]);
		expect(entries.every(({ balance }) => balance >= 0)).toBe(true);
		expect(entries.reduce((sum, { amount }) => sum + amount, 0)).toBe(10);
	});

	it("requires authentication for reads and denies another account by default", async () => {
		const { auth, client, signInWithTestUser } = await setup();
		expect((await client.credits.balance()).error?.status).toBe(401);
		expect((await client.credits.ledger()).error?.status).toBe(401);
		const { user, headers } = await signInWithTestUser();
		await auth.api.grantCredits({
			body: { referenceId: user.id, amount: 12, idempotencyKey: "private" },
		});
		expect(
			await client.credits.balance({ fetchOptions: { headers, throw: true } }),
		).toEqual({ referenceId: user.id, balance: 12 });
		const ledger = await client.credits.ledger({
			fetchOptions: { headers, throw: true },
		});
		expect(ledger.entries).toHaveLength(1);
		expect(ledger.entries[0]).not.toHaveProperty("idempotencyKey");
		await expect(
			auth.api.getCreditsBalance({
				headers,
				query: { referenceId: "other-account" },
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		await expect(
			auth.api.listCreditsLedger({
				headers,
				query: { referenceId: "other-account" },
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
	});

	it("requires application authorization for organization reads", async () => {
		const authorizeReference = vi.fn(
			({ referenceId }: { referenceId: string }) => referenceId === "team-1",
		);
		const { auth, signInWithTestUser } = await getTestInstance(
			{ plugins: [credits({ authorizeReference })] },
			{ testWith },
		);
		const { headers } = await signInWithTestUser();
		await auth.api.grantCredits({
			body: { referenceId: "team-1", amount: 50, idempotencyKey: "team-plan" },
		});
		expect(
			await auth.api.getCreditsBalance({
				headers,
				query: { referenceId: "team-1" },
			}),
		).toMatchObject({ balance: 50 });
		expect(
			(
				await auth.api.listCreditsLedger({
					headers,
					query: { referenceId: "team-1" },
				})
			).entries,
		).toHaveLength(1);
		await expect(
			auth.api.getCreditsBalance({
				headers,
				query: { referenceId: "team-2" },
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(authorizeReference).toHaveBeenCalledTimes(3);
	});

	it("keeps both balance mutations off HTTP and the inferred browser client", async () => {
		const { auth, client, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		for (const path of [
			"/credits/grant",
			"/credits/consume",
			"/grant-credits",
			"/consume-credits",
		]) {
			const requestHeaders = new Headers(headers);
			requestHeaders.set("content-type", "application/json");
			const response = await auth.handler(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method: "POST",
					headers: requestHeaders,
					body: JSON.stringify({
						referenceId: user.id,
						amount: 100,
						idempotencyKey: "untrusted",
					}),
				}),
			);
			expect(response.status).toBe(404);
		}
		expectTypeOf<"grantCredits">().not.toExtend<keyof typeof client>();
		expectTypeOf<"consumeCredits">().not.toExtend<keyof typeof client>();
		expectTypeOf<"grant" | "consume">().not.toExtend<
			keyof typeof client.credits
		>();
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 0,
		});
	});

	it("rejects invalid amounts and identifiers without writing entries", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = { referenceId: user.id, amount: 1, idempotencyKey: "valid" };
		for (const amount of [0, -1, 0.5, NaN, Infinity, 2 ** 53]) {
			await expect(
				auth.api.grantCredits({ body: { ...body, amount } }),
			).rejects.toBeDefined();
			await expect(
				auth.api.consumeCredits({ body: { ...body, amount } }),
			).rejects.toBeDefined();
		}
		for (const invalid of [
			{ ...body, referenceId: "" },
			{ ...body, referenceId: " " },
			{ ...body, idempotencyKey: "" },
			{ ...body, idempotencyKey: " " },
			{ ...body, reason: "r".repeat(501) },
		]) {
			await expect(
				auth.api.grantCredits({ body: invalid }),
			).rejects.toBeDefined();
		}
		expect((await auth.api.listCreditsLedger({ headers })).entries).toEqual([]);
	});

	it("supports exact integers above int32 and rejects balance overflow", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const body = {
			referenceId: user.id,
			amount: Number.MAX_SAFE_INTEGER,
			idempotencyKey: "large-grant",
		};
		await auth.api.grantCredits({ body });
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: Number.MAX_SAFE_INTEGER,
		});
		await expect(
			auth.api.grantCredits({
				body: { ...body, amount: 1, idempotencyKey: "overflow" },
			}),
		).rejects.toBeDefined();
		const consumed = await auth.api.consumeCredits({
			body: { ...body, amount: 2 ** 32, idempotencyKey: "large-debit" },
		});
		expect(consumed.entry.balance).toBe(Number.MAX_SAFE_INTEGER - 2 ** 32);
		expect(
			(await auth.api.listCreditsLedger({ headers })).entries,
		).toHaveLength(2);
	});

	it("paginates by sequence without duplicates or skipped older entries when a new entry arrives", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		for (let index = 1; index <= 5; index++) {
			await auth.api.grantCredits({
				body: {
					referenceId: user.id,
					amount: 1,
					idempotencyKey: `initial-${index}`,
				},
			});
		}
		const first = await auth.api.listCreditsLedger({
			headers,
			query: { limit: 2 },
		});
		expect(first.entries.map(({ sequence }) => sequence)).toEqual([5, 4]);
		expect(first.nextCursor).toBe(4);
		await auth.api.grantCredits({
			body: { referenceId: user.id, amount: 1, idempotencyKey: "newest" },
		});
		const second = await auth.api.listCreditsLedger({
			headers,
			query: { cursor: first.nextCursor ?? undefined, limit: 2 },
		});
		expect(second.entries.map(({ sequence }) => sequence)).toEqual([3, 2]);
		const last = await auth.api.listCreditsLedger({
			headers,
			query: { cursor: second.nextCursor ?? undefined, limit: 2 },
		});
		expect(last.entries.map(({ sequence }) => sequence)).toEqual([1]);
		expect(last.nextCursor).toBeNull();
		for (const query of [{ limit: 0 }, { limit: 101 }, { cursor: -1 }]) {
			await expect(
				auth.api.listCreditsLedger({ headers, query }),
			).rejects.toBeDefined();
		}
	});

	it("leaves no partial balance change after a storage failure and permits retrying the same key", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		await auth.api.grantCredits({
			body: { referenceId: user.id, amount: 40, idempotencyKey: "initial" },
		});
		const { adapter } = await auth.$context;
		const body = { referenceId: user.id, amount: 10, idempotencyKey: "retry" };
		vi.spyOn(adapter, "create").mockRejectedValueOnce(
			new Error("storage down"),
		);
		await expect(auth.api.consumeCredits({ body })).rejects.toThrow(
			"storage down",
		);
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 40,
		});
		expect((await auth.api.consumeCredits({ body })).applied).toBe(true);
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 30,
		});
		expect(
			(await auth.api.listCreditsLedger({ headers })).entries,
		).toHaveLength(2);
	});

	it("recovers an uncertain committed insert without applying it twice", async () => {
		const { auth, signInWithTestUser } = await setup();
		const { user, headers } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		const originalCreate = adapter.create.bind(adapter);
		vi.spyOn(adapter, "create").mockImplementationOnce(async (args) => {
			await originalCreate(args);
			throw new Error("connection lost after commit");
		});
		const body = {
			referenceId: user.id,
			amount: 25,
			idempotencyKey: "uncertain",
		};
		const result = await auth.api.grantCredits({ body });
		expect(result.entry.balance).toBe(25);
		expect(await auth.api.grantCredits({ body })).toMatchObject({
			applied: false,
			entry: { id: result.entry.id },
		});
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 25,
		});
		expect(
			(await auth.api.listCreditsLedger({ headers })).entries,
		).toHaveLength(1);
	});

	it("preserves uniqueness and numeric conversion with custom table and field mappings", async () => {
		const plugin = credits({
			schema: {
				creditEntry: {
					modelName: "appCreditLedger",
					fields: {
						referenceId: "owner_id",
						sequence: "entry_sequence",
						idempotencyKey: "request_key",
						amount: "credit_delta",
						balance: "remaining_credits",
					},
				},
			},
		});
		const { auth, signInWithTestUser } = await getTestInstance(
			{ plugins: [plugin] },
			{ testWith },
		);
		const { user, headers } = await signInWithTestUser();
		const body = {
			referenceId: user.id,
			amount: 2 ** 32,
			idempotencyKey: "one",
		};
		const first = await auth.api.grantCredits({ body });
		expect((await auth.api.grantCredits({ body })).applied).toBe(false);
		const { adapter } = await auth.$context;
		const { id: _id, ...stored } = first.entry;
		await expect(
			adapter.create({
				model: "creditEntry",
				data: { ...stored, idempotencyKey: "different-key" },
			}),
		).rejects.toBeDefined();
		await expect(
			adapter.create({
				model: "creditEntry",
				data: { ...stored, sequence: 2 },
			}),
		).rejects.toBeDefined();
		expect(await auth.api.getCreditsBalance({ headers })).toMatchObject({
			balance: 2 ** 32,
		});
		expect(credits().schema.creditEntry).not.toHaveProperty("modelName");
	});

	it("decodes PostgreSQL bigint strings exactly and rejects lossy or malformed database values", () => {
		const { fields } = createCreditsSchema().creditEntry;
		for (const field of [fields.amount, fields.balance, fields.sequence]) {
			const decode = field.transform.output;
			expect(decode("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
			expect(decode(4294967296n)).toBe(2 ** 32);
			expect(decode("-4294967296")).toBe(-(2 ** 32));
			expect(decode(0)).toBe(0);
			for (const value of [
				"9007199254740992",
				9007199254740992n,
				"",
				"1.5",
				" 1",
				null,
				undefined,
				NaN,
				Infinity,
				{},
			]) {
				expect(() => decode(value)).toThrow(/safe integer/i);
			}
		}
	});

	it("rejects the memory adapter because it cannot enforce SQL uniqueness", async () => {
		const auth = betterAuth({
			secret: "credits-test-secret-long-enough-for-validation",
			baseURL: "http://localhost:3000",
			database: memoryAdapter({}),
			plugins: [credits()],
		});
		await expect(auth.$context).rejects.toThrow(/memory|unique|SQL/i);
	});
});
