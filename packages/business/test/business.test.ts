import * as creditsModule from "@app/credits";
import { createCreditsService, credits } from "@app/credits";
import type { Subscription } from "@app/subscription";
import { createProductService, subscription } from "@app/subscription";
import { parseJSON } from "better-auth/client";
import { admin } from "better-auth/plugins/admin";
import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { business } from "../src";
import { businessClient } from "../src/client";
import type {
	BusinessOrder,
	BusinessPaymentProvider,
	VerifiedPayment,
	VerifiedRefund,
} from "../src/types";

const day = 86_400_000;

const productInput = {
	key: "pro",
	name: "Pro",
	type: "bundle" as const,
	amount: 1000,
	currency: "USD",
	credits: 100,
	membershipDays: 30,
	creditValidityDays: 30,
	limits: { exports: true },
	published: true,
	expectedVersion: 0,
};

async function setup(basePath = "/api/auth") {
	const refunds = new Map<string, VerifiedRefund>();
	const payments: BusinessPaymentProvider = {
		createCheckout: vi.fn(async (order) => ({
			providerOrderId: `remote-${order.id}`,
			url: `https://pay.example/${order.id}`,
		})),
		verifyPayment: vi.fn(async ({ order }) => ({
			paymentId: `paid-${order.id}`,
			providerOrderId: `remote-${order.id}`,
			amount: order.amount,
			currency: order.currency,
			paidAt: order.createdAt,
		})),
		verifyRefund: vi.fn(async ({ reference }) => {
			const refund = refunds.get(reference);
			if (!refund) throw new Error("Refund has not been verified");
			return refund;
		}),
	};
	const instance = await getTestInstance(
		{
			basePath,
			plugins: [
				admin({ auditLog: true }),
				subscription({ catalog: true }),
				credits(),
				business({ providers: { test: payments } }),
			],
			session: { cookieCache: { enabled: true } },
		},
		{ clientOptions: { plugins: [businessClient()] } },
	);
	const { adapter } = await instance.auth.$context;
	const products = createProductService(adapter);
	const product = await products.save(productInput);
	const { user, headers } = await instance.signInWithTestUser();
	async function buy(
		productId = product.id,
		key: string = crypto.randomUUID(),
	) {
		const order = await instance.auth.api.createBusinessOrder({
			headers,
			body: { productId, provider: "test", idempotencyKey: key },
		});
		return instance.auth.api.checkoutBusinessOrder({
			headers,
			body: { orderId: order.id },
		});
	}
	async function pay(order: BusinessOrder) {
		return instance.auth.api.confirmBusinessPayment({
			body: { orderId: order.id, reference: `remote-${order.id}` },
		});
	}
	async function makeAdmin() {
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "admin" },
		});
	}
	return {
		...instance,
		adapter,
		products,
		product,
		user,
		headers,
		payments,
		refunds,
		buy,
		pay,
		makeAdmin,
	};
}

describe("business workflows", () => {
	it("exposes configured channels and verifies only the signed-in customer's persisted checkout", async () => {
		const { auth, client, headers, buy, payments, adapter, user } =
			await setup();
		const fetchOptions = { headers, throw: true as const };
		expect(await client.business.providers({ fetchOptions })).toEqual({
			providers: ["test"],
		});
		const order = await buy();
		await expect(
			auth.api.completeBusinessOrder({
				headers: new Headers(),
				body: { orderId: order.id },
			}),
		).rejects.toThrow();
		await adapter.update({
			model: "businessOrder",
			where: [{ field: "id", value: order.id }],
			update: { referenceId: "someone-else" },
		});
		await expect(
			auth.api.completeBusinessOrder({ headers, body: { orderId: order.id } }),
		).rejects.toThrow("Order does not belong");
		expect(payments.verifyPayment).not.toHaveBeenCalled();
		await adapter.update({
			model: "businessOrder",
			where: [{ field: "id", value: order.id }],
			update: { referenceId: user.id },
		});
		const completed = await client.business.orders.complete({
			orderId: order.id,
			fetchOptions,
		});
		expect(completed.status).toBe("fulfilled");
		expect(payments.verifyPayment).toHaveBeenCalledWith({
			order: expect.objectContaining({ id: order.id }),
			reference: order.providerOrderId,
		});
		await client.business.orders.complete({ orderId: order.id, fetchOptions });
		expect(payments.verifyPayment).toHaveBeenCalledTimes(1);
		expect((await createCreditsService(adapter).balance(user.id)).balance).toBe(
			productInput.credits,
		);
	});

	it("preserves JSON dates through the browser client without changing ordinary response dates", async () => {
		const { auth, client, user, headers, product, makeAdmin, pay } =
			await setup("/internal/auth");
		await makeAdmin();
		const fetchOptions = { headers, throw: true as const };
		const limits = {
			opensAt: "2027-01-01T08:00:00+08:00",
			nested: { dates: ["2028-01-01T12:00:00+12:00"] },
		};
		const saved = await client.business.admin.products.save({
			operationId: "browser-product",
			reason: "Update limits",
			product: { ...productInput, expectedVersion: product.version, limits },
			fetchOptions,
		});
		expect(saved.createdAt).toEqual(expect.any(String));
		expect(saved.limits).toEqual(limits);
		const catalog = await client.business.products({ fetchOptions });
		expect(catalog[0]!.createdAt).toBeInstanceOf(Date);
		expect(catalog[0]!.limits).toEqual(limits);
		const customParser = vi.fn((text: string) =>
			parseJSON<{ name: string; [key: string]: unknown }[]>(text).map(
				(item) => ({ ...item, name: "Custom parsed product" }),
			),
		);
		const custom = await client.business.products({
			fetchOptions: { ...fetchOptions, jsonParser: customParser },
		});
		expect(customParser).toHaveBeenCalledOnce();
		expect(custom[0]!.name).toBe("Custom parsed product");
		expect(custom[0]!.limits).toEqual(limits);
		const grant = await client.business.admin.credits.adjust({
			operationId: "browser-credit",
			referenceId: user.id,
			action: "grant",
			amount: 10,
			reason: "Correction",
			fetchOptions,
		});
		expect(grant.entry.createdAt).toEqual(expect.any(String));
		const order = await client.business.orders.create({
			productId: saved.id,
			provider: "test",
			idempotencyKey: "browser-order",
			fetchOptions,
		});
		expect(order.createdAt).toBeInstanceOf(Date);
		expect(order.product.createdAt).toEqual(expect.any(String));
		expect(order.product.limits).toEqual(limits);
		const checkout = await client.business.orders.checkout({
			orderId: order.id,
			fetchOptions,
		});
		expect(checkout.product.createdAt).toBe(saved.createdAt);
		await pay(checkout);
		const customer = await client.business.admin.customer({
			query: { referenceId: user.id },
			fetchOptions,
		});
		expect(customer.user.createdAt).toBeInstanceOf(Date);
		expect(customer.subscriptions[0]!.periodEnd).toBeInstanceOf(Date);
		expect(customer.subscriptions[0]!.limits).toEqual(limits);
		expect(customer.orders.orders[0]!.createdAt).toBeInstanceOf(Date);
		expect(customer.orders.orders[0]!.product.createdAt).toEqual(
			expect.any(String),
		);
		expect(customer.orders.orders[0]!.product.limits).toEqual(limits);
		expect(
			(await auth.api.listCustomerSubscriptions({ headers }))[0]!.limits,
		).toEqual(limits);
	});

	it("preserves prepaid membership time across product edits and publication versions", async () => {
		const { auth, headers, products, buy, pay } = await setup();
		const first = await pay(await buy());
		expect(first.createdAt).toBeInstanceOf(Date);
		expect(first.product.createdAt).toEqual(expect.any(String));
		const edited = await products.save({
			...productInput,
			expectedVersion: 1,
			membershipDays: 45,
			limits: { exports: false },
		});
		const second = await pay(await buy(edited.id));
		expect(second.periodStart).toEqual(first.periodEnd);
		expect(second.periodEnd!.getTime() - second.periodStart!.getTime()).toBe(
			45 * day,
		);
		expect(second.product.limits).toEqual({ exports: false });
		await products.setPublished({
			key: "pro",
			expectedVersion: 2,
			published: false,
		});
		const republished = await products.setPublished({
			key: "pro",
			expectedVersion: 3,
			published: true,
		});
		const third = await pay(await buy(republished.id));
		expect(third.periodStart).toEqual(second.periodEnd);
		expect(await auth.api.listCustomerSubscriptions({ headers })).toMatchObject(
			[{ limits: { exports: true } }],
		);
		expect((await auth.api.listOwnBusinessOrders({ headers })).total).toBe(3);
	});

	it("records each verified recurring payment as one child order with its absolute billing period", async () => {
		const { auth, adapter, user, payments, buy, pay, client } = await setup();
		const original = await pay(await buy());
		const periodStart = original.periodEnd!;
		const periodEnd = new Date(periodStart.getTime() + 30 * day);
		const renewedAt = new Date();
		const verified = new Map<string, VerifiedPayment>([
			[
				"renewal-1",
				{
					paymentId: "renewal-1",
					providerOrderId: original.providerOrderId!,
					amount: original.amount,
					currency: original.currency,
					paidAt: renewedAt,
					periodStart,
					periodEnd,
				},
			],
			[
				"renewal-2",
				{
					paymentId: "renewal-2",
					providerOrderId: original.providerOrderId!,
					amount: original.amount,
					currency: original.currency,
					paidAt: renewedAt,
					periodStart: periodEnd,
					periodEnd: new Date(periodEnd.getTime() + 30 * day),
				},
			],
		]);
		payments.verifyPayment = async ({ reference }) => {
			const payment = verified.get(reference);
			if (!payment) throw new Error("Payment has not been verified");
			return payment;
		};
		const body = { orderId: original.id, reference: "renewal-1" };
		const children = await Promise.all(
			Array.from({ length: 3 }, () =>
				auth.api.confirmBusinessRenewal({ body }),
			),
		);
		expect(new Set(children.map((order) => order.id)).size).toBe(1);
		expect(children[0]).toMatchObject({
			parentOrderId: original.id,
			paymentId: "renewal-1",
			status: "fulfilled",
			periodStart,
			periodEnd,
		});
		const next = await auth.api.confirmBusinessRenewal({
			body: { orderId: original.id, reference: "renewal-2" },
		});
		expect(next.id).not.toBe(children[0]!.id);
		expect(next.parentOrderId).toBe(original.id);
		expect(next.periodStart).toEqual(periodEnd);
		await auth.api.confirmBusinessRenewal({ body });
		expect(await adapter.count({ model: "businessOrder" })).toBe(3);
		expect(await adapter.count({ model: "businessPaymentEvent" })).toBe(3);
		expect(await adapter.count({ model: "subscription" })).toBe(3);
		expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
			balance: 300,
		});
		expectTypeOf<"confirmBusinessRenewal">().not.toExtend<
			keyof typeof client
		>();
	});

	it("opens, extends and ends manual memberships with revision checks and stable JSON retries", async () => {
		const { auth, adapter, user, headers, product, makeAdmin } = await setup();
		const body = {
			operationId: "membership-open",
			referenceId: user.id,
			productId: product.id,
			status: "active" as const,
			periodStart: new Date(Date.now() - day).toISOString(),
			periodEnd: new Date(Date.now() + 30 * day).toISOString(),
			reason: "Support membership correction",
		};
		await expect(
			auth.api.adjustBusinessMembership({ headers, body }),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		await makeAdmin();
		const opened = await auth.api.adjustBusinessMembership({ headers, body });
		expect(opened.subscription).toMatchObject({
			revision: 0,
			status: "active",
			periodStart: body.periodStart,
			periodEnd: body.periodEnd,
		});
		expect(await auth.api.adjustBusinessMembership({ headers, body })).toEqual(
			opened,
		);
		const extendedBody = {
			...body,
			operationId: "membership-extend",
			subscriptionId: opened.subscription.id,
			expectedRevision: 0,
			periodEnd: new Date(Date.now() + 60 * day).toISOString(),
		};
		const extended = await auth.api.adjustBusinessMembership({
			headers,
			body: extendedBody,
		});
		expect(extended.subscription).toMatchObject({
			id: opened.subscription.id,
			revision: 1,
			periodEnd: extendedBody.periodEnd,
		});
		expect(
			await auth.api.adjustBusinessMembership({ headers, body: extendedBody }),
		).toEqual(extended);
		await expect(
			auth.api.adjustBusinessMembership({
				headers,
				body: { ...extendedBody, operationId: "stale-membership-edit" },
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		const endedBody = {
			...extendedBody,
			operationId: "membership-end",
			expectedRevision: 1,
			status: "canceled" as const,
		};
		const ended = await auth.api.adjustBusinessMembership({
			headers,
			body: endedBody,
		});
		expect(ended.subscription).toMatchObject({
			revision: 2,
			status: "canceled",
			endedAt: expect.any(String),
		});
		expect(
			await auth.api.adjustBusinessMembership({ headers, body: endedBody }),
		).toEqual(ended);
		expect(await auth.api.listCustomerSubscriptions({ headers })).toEqual([]);
		expect(await adapter.count({ model: "subscription" })).toBe(1);
		expect(await adapter.count({ model: "businessAction" })).toBe(3);
	});

	it("authorizes and deduplicates catalog edits while rejecting competing editor versions", async () => {
		const { auth, headers, products, makeAdmin } = await setup();
		const body = {
			operationId: "product-edit",
			reason: "Update storefront",
			product: { ...productInput, expectedVersion: 1, amount: 1500 },
		};
		const publish = {
			operationId: "product-publish",
			reason: "Pause sales",
			key: "pro",
			expectedVersion: 1,
			published: false,
		};
		await expect(
			auth.api.saveBusinessProduct({ headers, body }),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		await expect(
			auth.api.publishBusinessProduct({ headers, body: publish }),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		await makeAdmin();
		const edited = await auth.api.saveBusinessProduct({ headers, body });
		expect(edited).toMatchObject({
			version: 2,
			amount: 1500,
			createdAt: expect.any(String),
		});
		expect(await auth.api.saveBusinessProduct({ headers, body })).toEqual(
			edited,
		);
		const attempts = await Promise.allSettled(
			[1600, 1700].map((amount) =>
				auth.api.saveBusinessProduct({
					headers,
					body: {
						...body,
						operationId: `product-edit-${amount}`,
						product: { ...body.product, expectedVersion: 2, amount },
					},
				}),
			),
		);
		expect(
			attempts.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		for (const result of attempts)
			if (result.status === "rejected")
				expect(result.reason).toMatchObject({ status: "CONFLICT" });
		const publication = { ...publish, expectedVersion: 3 };
		const unpublished = await auth.api.publishBusinessProduct({
			headers,
			body: publication,
		});
		expect(unpublished).toMatchObject({
			version: 4,
			published: false,
			createdAt: expect.any(String),
		});
		expect(
			await auth.api.publishBusinessProduct({ headers, body: publication }),
		).toEqual(unpublished);
		expect(await auth.api.listBusinessProducts({ headers })).toEqual([]);
		expect(await products.get(edited.id)).toMatchObject({
			version: 2,
			amount: 1500,
			published: true,
		});
		await expect(
			auth.api.publishBusinessProduct({
				headers,
				body: { ...publication, operationId: "stale-publish", published: true },
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
	});

	it("increments refunded membership revisions and prevents manual reactivation of the paid grant", async () => {
		const {
			auth,
			adapter,
			user,
			headers,
			product,
			refunds,
			buy,
			pay,
			makeAdmin,
		} = await setup();
		const order = await pay(await buy());
		const [initial] = await auth.api.listCustomerSubscriptions({ headers });
		await makeAdmin();
		const adjustment = {
			operationId: "extend-paid-membership",
			referenceId: user.id,
			productId: product.id,
			subscriptionId: initial!.id,
			expectedRevision: 0,
			status: "active" as const,
			periodStart: order.periodStart!,
			periodEnd: new Date(order.periodEnd!.getTime() + day),
			reason: "Support correction",
		};
		await auth.api.adjustBusinessMembership({ headers, body: adjustment });
		refunds.set("full", {
			refundId: "full",
			paymentId: order.paymentId!,
			amount: order.amount,
			currency: order.currency,
			refundedAt: new Date(),
		});
		await auth.api.confirmBusinessRefund({
			body: { orderId: order.id, reference: "full" },
		});
		const refunded = await adapter.findOne<Subscription>({
			model: "subscription",
			where: [{ field: "id", value: initial!.id }],
		});
		expect(refunded).toMatchObject({
			revision: 2,
			status: "canceled",
		});
		await expect(
			auth.api.adjustBusinessMembership({
				headers,
				body: {
					...adjustment,
					operationId: "reactivate-refunded",
					expectedRevision: 2,
				},
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		await auth.api.confirmBusinessRefund({
			body: { orderId: order.id, reference: "full" },
		});
		await pay(order);
		expect(await auth.api.listCustomerSubscriptions({ headers })).toEqual([]);
		expect(
			await adapter.findOne<Subscription>({
				model: "subscription",
				where: [{ field: "id", value: initial!.id }],
			}),
		).toMatchObject({ revision: 2, status: "canceled" });
	});

	it("fulfills credits, membership and bundle purchases using independent existing plugins", async () => {
		const { auth, adapter, products, user, headers, buy, pay } = await setup();
		for (const type of ["credits", "membership", "bundle"] as const) {
			const product = await products.save({
				...productInput,
				key: type,
				type,
				credits: type === "membership" ? 0 : 100,
				membershipDays: type === "credits" ? null : 30,
				creditValidityDays: type === "membership" ? null : 30,
			});
			const result = await pay(await buy(product.id));
			expect(result.status).toBe("fulfilled");
		}
		expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
			balance: 200,
		});
		expect(await auth.api.listCustomerSubscriptions({ headers })).toHaveLength(
			2,
		);
		expect(await adapter.count({ model: "businessPaymentEvent" })).toBe(3);
	});

	it("freezes order prices and product versions and rejects changed idempotent requests", async () => {
		const { auth, headers, products, product, buy, pay, payments } =
			await setup();
		const order = await buy(product.id, "purchase");
		await products.save({
			...productInput,
			expectedVersion: 1,
			amount: 2500,
			credits: 300,
			limits: { exports: false },
		});
		expect((await buy(product.id, "purchase")).id).toBe(order.id);
		await expect(
			auth.api.createBusinessOrder({
				headers,
				body: {
					productId: product.id,
					provider: "test",
					idempotencyKey: "new",
				},
			}),
		).rejects.toBeDefined();
		const latest = await products.getLatest("pro");
		await expect(
			auth.api.createBusinessOrder({
				headers,
				body: {
					productId: latest!.id,
					provider: "test",
					idempotencyKey: "purchase",
				},
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		expect((await pay(order)).product).toMatchObject({
			amount: 1000,
			credits: 100,
			limits: { exports: true },
		});
		expect(payments.createCheckout).toHaveBeenCalledTimes(1);
	});

	it("deduplicates concurrent payments and rolls back all entitlements when fulfillment fails", async () => {
		const { auth, adapter, user, buy, pay, makeAdmin, headers } = await setup();
		const order = await buy();
		const real = creditsModule.createCreditsService;
		const broken = vi
			.spyOn(creditsModule, "createCreditsService")
			.mockImplementation((db) => ({
				...real(db),
				grant: async () => {
					throw new Error("Injected ledger outage");
				},
			}));
		await expect(pay(order)).rejects.toThrow("Injected ledger outage");
		broken.mockRestore();
		expect(await adapter.count({ model: "subscription" })).toBe(0);
		expect(await adapter.count({ model: "creditEntry" })).toBe(0);
		expect(
			await adapter.findOne({
				model: "businessOrder",
				where: [{ field: "id", value: order.id }],
			}),
		).toMatchObject({ status: "paid", fulfilledAt: null });
		await makeAdmin();
		await auth.api.retryBusinessFulfillment({
			headers,
			body: { orderId: order.id },
		});
		await Promise.all(Array.from({ length: 4 }, () => pay(order)));
		expect(await adapter.count({ model: "subscription" })).toBe(1);
		expect(await adapter.count({ model: "businessPaymentEvent" })).toBe(1);
		expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
			balance: 100,
		});
	});

	it("does not trust mismatched provider amounts, ownership or browser confirmation routes", async () => {
		const { auth, adapter, buy, pay, payments, client } = await setup();
		const order = await buy();
		payments.verifyPayment = async ({ order }) => ({
			paymentId: "wrong",
			providerOrderId: order.providerOrderId!,
			amount: order.amount + 1,
			currency: order.currency,
			paidAt: order.createdAt,
		});
		await expect(pay(order)).rejects.toMatchObject({ status: "CONFLICT" });
		expect(await adapter.count({ model: "creditEntry" })).toBe(0);
		expect(await adapter.count({ model: "businessPaymentEvent" })).toBe(0);
		for (const path of [
			"/business/payment/confirm",
			"/confirm-business-payment",
			"/confirm-business-refund",
		]) {
			const response = await auth.handler(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ orderId: order.id, reference: "fake" }),
				}),
			);
			expect(response.status).toBe(404);
		}
		expectTypeOf<"confirmBusinessPayment">().not.toExtend<
			keyof typeof client
		>();
	});

	it("rejects unowned checkout and scopes customer order lists", async () => {
		const { auth, headers, buy } = await setup();
		const order = await buy();
		const other = await auth.api.signUpEmail({
			body: {
				name: "Other",
				email: "other@business.test",
				password: "password-long-enough",
			},
		});
		const signed = await auth.api.signInEmail({
			body: { email: other.user.email, password: "password-long-enough" },
			returnHeaders: true,
		});
		const otherHeaders = new Headers({
			cookie: signed.headers.get("set-cookie")!,
		});
		await expect(
			auth.api.checkoutBusinessOrder({
				headers: otherHeaders,
				body: { orderId: order.id },
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(
			(await auth.api.listOwnBusinessOrders({ headers: otherHeaders })).orders,
		).toHaveLength(0);
		expect(
			(await auth.api.listOwnBusinessOrders({ headers })).orders,
		).toHaveLength(1);
	});

	it("uses authoritative admin permissions and records idempotent manual changes", async () => {
		const { auth, adapter, user, headers, makeAdmin } = await setup();
		const body = {
			operationId: "adjust-1",
			referenceId: user.id,
			action: "grant" as const,
			amount: 20,
			reason: "Support correction",
		};
		await expect(
			auth.api.adjustBusinessCredits({ headers, body }),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		await makeAdmin();
		await auth.api.adjustBusinessCredits({ headers, body });
		await auth.api.adjustBusinessCredits({ headers, body });
		await expect(
			auth.api.adjustBusinessCredits({
				headers,
				body: { ...body, amount: 30 },
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
			balance: 20,
		});
		expect(await adapter.count({ model: "adminAuditLog" })).toBe(1);
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "user" },
		});
		await expect(
			auth.api.getBusinessOverview({ headers }),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
	});

	it("reclaims only the refunded grant and reports already consumed credits for review", async () => {
		const { auth, adapter, user, headers, refunds, buy, pay } = await setup();
		const order = await pay(await buy());
		const credit = createCreditsService(adapter);
		await credit.consume({
			referenceId: user.id,
			amount: 40,
			idempotencyKey: "usage",
		});
		await credit.grant({
			referenceId: user.id,
			amount: 500,
			idempotencyKey: "other-purchase",
		});
		refunds.set("refund-1", {
			refundId: "refund-1",
			paymentId: order.paymentId!,
			amount: order.amount,
			currency: order.currency,
			refundedAt: new Date(),
		});
		const body = { orderId: order.id, reference: "refund-1" };
		expect(await auth.api.confirmBusinessRefund({ body })).toMatchObject({
			status: "refunded",
			reviewRequired: true,
		});
		await auth.api.confirmBusinessRefund({ body });
		await pay(order);
		expect(await credit.balance(user.id)).toMatchObject({ balance: 500 });
		expect(await auth.api.listCustomerSubscriptions({ headers })).toHaveLength(
			0,
		);
	});

	it("tracks partial refunds without inventing an automatic proportional entitlement policy", async () => {
		const { auth, adapter, user, refunds, buy, pay } = await setup();
		const order = await pay(await buy());
		refunds.set("partial", {
			refundId: "partial",
			paymentId: order.paymentId!,
			amount: 400,
			currency: order.currency,
			refundedAt: new Date(),
		});
		expect(
			await auth.api.confirmBusinessRefund({
				body: { orderId: order.id, reference: "partial" },
			}),
		).toMatchObject({
			status: "partially_refunded",
			reviewRequired: true,
			refundedAmount: 400,
		});
		expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
			balance: 100,
		});
		refunds.set("rest", {
			refundId: "rest",
			paymentId: order.paymentId!,
			amount: 600,
			currency: order.currency,
			refundedAt: new Date(),
		});
		expect(
			await auth.api.confirmBusinessRefund({
				body: { orderId: order.id, reference: "rest" },
			}),
		).toMatchObject({
			status: "refunded",
			reviewRequired: false,
			refundedAmount: 1000,
		});
		expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
			balance: 0,
		});
	});

	it("reconciles late payments after the payment window and reports distinct paid users", async () => {
		const { auth, adapter, headers, user, buy, pay, makeAdmin } = await setup();
		const order = await buy();
		await adapter.update({
			model: "businessOrder",
			where: [{ field: "id", value: order.id }],
			update: { expiresAt: new Date(0) },
		});
		await expect(
			auth.api.checkoutBusinessOrder({ headers, body: { orderId: order.id } }),
		).rejects.toBeDefined();
		expect((await pay(order)).status).toBe("fulfilled");
		await pay(await buy());
		await makeAdmin();
		expect(await auth.api.getBusinessOverview({ headers })).toMatchObject({
			paidUsersThisMonth: 1,
			paymentScope: "business-orders",
		});
		expect(
			await auth.api.getBusinessCustomer({
				headers,
				query: { referenceId: user.id },
			}),
		).toMatchObject({ credits: { balance: 200 }, orders: { total: 2 } });
	});
});
