import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { createProductService, productPlanName, subscription } from "../src";
import {
	createProductSchema,
	createProviderSubscriptionSchema,
} from "../src/schema";

const product = {
	key: "pro",
	name: "Pro monthly",
	type: "bundle" as const,
	amount: 1200,
	currency: "USD",
	credits: 100,
	membershipDays: 30,
	creditValidityDays: 30,
	limits: { projects: 10 },
	published: true,
	expectedVersion: 0,
};

describe("persistent subscription catalog", () => {
	it("preserves ISO strings in JSON limits through publication changes", async () => {
		const { auth } = await getTestInstance({
			plugins: [subscription({ catalog: true })],
		});
		const service = createProductService((await auth.$context).adapter);
		const limits = {
			availableFrom: "2026-10-08T00:00:00.000Z",
			nested: { dates: ["2027-01-01T00:00:00.000Z"] },
		};
		const saved = await service.save({ ...product, limits });
		expect((await service.get(saved.id))?.limits).toEqual(limits);
		await service.setPublished({
			key: product.key,
			expectedVersion: 1,
			published: false,
		});
		const published = await service.setPublished({
			key: product.key,
			expectedVersion: 2,
			published: true,
		});
		expect(published.limits).toEqual(limits);
	});

	it("stores supported safe integers in SQL bigint columns and normalizes driver outputs", () => {
		const schema = createProductSchema();
		const { amount, credits, version } = schema.subscriptionProduct.fields;
		const { revision } = createProviderSubscriptionSchema().subscription.fields;
		for (const field of [amount, credits, version, revision]) {
			expect(field.bigint).toBe(true);
			expect(field.transform.output("9007199254740991")).toBe(
				Number.MAX_SAFE_INTEGER,
			);
			expect(() => field.transform.output("9007199254740992")).toThrow();
		}
		expect(revision.transform.output(null)).toBeNull();
	});
	it("keeps immutable product versions and rejects competing SQL writes", async () => {
		const { auth } = await getTestInstance({
			plugins: [subscription({ catalog: true })],
		});
		const { adapter } = await auth.$context;
		const service = createProductService(adapter);
		const first = await service.save(product);
		const attempts = await Promise.allSettled([
			service.save({ ...product, amount: 1300, expectedVersion: 1 }),
			service.save({ ...product, amount: 1400, expectedVersion: 1 }),
		]);
		expect(
			attempts.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			attempts.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		for (const result of attempts) {
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ status: "CONFLICT" });
		}
		expect(await service.get(first.id)).toMatchObject({
			version: 1,
			amount: 1200,
		});
		expect(await service.getLatest("pro")).toMatchObject({ version: 2 });
		expect(await service.list()).toHaveLength(1);
	});

	it("preserves old membership entitlements after edits and unpublishing", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ catalog: true })],
		});
		const { user, headers } = await signInWithTestUser();
		const service = createProductService((await auth.$context).adapter);
		const first = await service.save(product);
		await auth.api.syncSubscription({
			body: {
				provider: "business",
				providerSubscriptionId: "purchase-1",
				referenceId: user.id,
				plan: productPlanName(first),
				status: "active",
				revision: 0,
				periodStart: new Date(Date.now() - 1000),
				periodEnd: new Date(Date.now() + 86_400_000),
			},
		});
		await service.save({
			...product,
			expectedVersion: 1,
			limits: { projects: 20 },
		});
		await service.setPublished({
			key: "pro",
			expectedVersion: 2,
			published: false,
		});
		expect(await service.list({ publishedOnly: true })).toEqual([]);
		expect(await auth.api.listSubscriptionPlans({ headers })).toEqual([]);
		expect(await auth.api.listCustomerSubscriptions({ headers })).toMatchObject(
			[{ plan: productPlanName(first), limits: { projects: 10 } }],
		);
	});

	it("keeps credits-only products out of memberships and rejects invalid prices", async () => {
		const { auth } = await getTestInstance({
			plugins: [subscription({ catalog: true })],
		});
		const service = createProductService((await auth.$context).adapter);
		const credits = {
			...product,
			key: "top-up",
			type: "credits" as const,
			membershipDays: null,
		};
		for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(service.save({ ...credits, amount })).rejects.toBeDefined();
		}
		await expect(
			service.save({ ...product, membershipDays: 36_501 }),
		).rejects.toBeDefined();
		await expect(
			service.save({ ...credits, creditValidityDays: 36_501 }),
		).rejects.toBeDefined();
		const saved = await service.save(credits);
		await expect(
			auth.api.syncSubscription({
				body: {
					provider: "business",
					providerSubscriptionId: "purchase-1",
					referenceId: "user",
					plan: productPlanName(saved),
					status: "active",
					revision: 0,
					periodStart: new Date(),
					periodEnd: new Date(Date.now() + 86_400_000),
				},
			}),
		).rejects.toMatchObject({ status: "BAD_REQUEST" });
		expect(
			await (await auth.$context).adapter.count({ model: "subscription" }),
		).toBe(0);
	});
});
