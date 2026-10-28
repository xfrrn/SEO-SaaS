import { credits } from "@app/credits";
import { subscription } from "@app/subscription";
import { admin } from "better-auth/plugins/admin";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";
import { business, createBusinessService, purchasePolicy } from "../src";
import type { BusinessPaymentProvider } from "../src/types";

async function fixture() {
	const { auth, signInWithTestUser } = await getTestInstance({
		plugins: [
			admin({ auditLog: true }),
			subscription({ catalog: true }),
			credits(),
			business(),
		],
	});
	const { user } = await signInWithTestUser();
	const { adapter } = await auth.$context;
	let state: "open" | "paid" | "closed" | "unknown" = "unknown";
	const provider: BusinessPaymentProvider = {
		createCheckout: async (order) => ({
			providerOrderId: `remote-${order.id}`,
			url: "https://pay.example/checkout",
		}),
		verifyPayment: async ({ order }) => ({
			paymentId: `payment-${order.id}`,
			providerOrderId: order.providerOrderId!,
			amount: order.amount,
			currency: order.currency,
			paidAt: order.createdAt,
		}),
		inspectCheckout: async () => ({ state }),
		verifyRefund: async ({ order }) => ({
			refundId: `refund-${order.id}`,
			paymentId: order.paymentId!,
			amount: order.amount,
			currency: order.currency,
			refundedAt: new Date(),
		}),
	};
	const service = createBusinessService(
		adapter,
		{ catalog: true },
		{ providers: { test: provider, second: provider } },
	);
	const pack = (key: string, limits = {}) =>
		service.products.save({
			key,
			name: key,
			type: "credits",
			amount: 1499,
			currency: "USD",
			credits: 150,
			limits,
			expectedVersion: 0,
			published: true,
		});
	return {
		adapter,
		user,
		service,
		pack,
		inspect: (value: typeof state) => {
			state = value;
		},
	};
}

it("quotes per-product first purchases in minor units, snapshots discounts and preserves legacy checkout", async () => {
	const { user, service, pack } = await fixture();
	const product = await pack("discounted", {
		purchase: { firstPurchaseOffer: { type: "percent", percentOff: 10 } },
	});
	const quote = await service.quoteOrder(user.id, product.id);
	expect(quote).toMatchObject({
		amount: 1349,
		baseAmount: 1499,
		discountAmount: 150,
		firstPurchase: true,
		canPurchase: true,
	});
	await expect(
		service.createOrder(user.id, {
			productId: product.id,
			provider: "test",
			idempotencyKey: "missing",
		}),
	).rejects.toMatchObject({ body: { code: "PURCHASE_QUOTE_CHANGED" } });
	const order = await service.createOrder(user.id, {
		productId: product.id,
		provider: "test",
		idempotencyKey: "first",
		quoteVersion: quote.quoteVersion,
	});
	expect(order).toMatchObject({
		amount: 1349,
		product: { amount: 1499 },
		pricing: { baseAmount: 1499, discountAmount: 150 },
	});
	await expect(
		service.createOrder(user.id, {
			productId: product.id,
			provider: "second",
			idempotencyKey: "second-channel",
			quoteVersion: quote.quoteVersion,
		}),
	).rejects.toMatchObject({ body: { code: "PURCHASE_PENDING" } });
	expect(
		(
			await service.createOrder(user.id, {
				productId: product.id,
				provider: "test",
				idempotencyKey: "first",
			})
		).id,
	).toBe(order.id);
	await service.checkout(user.id, order.id);
	await service.confirmPayment(order.id, "verified");
	await service.confirmPayment(order.id, "verified");
	expect(await service.quoteOrder(user.id, product.id)).toMatchObject({
		amount: 1499,
		purchaseCount: 1,
		firstPurchase: false,
	});
	const other = await pack("other", {
		purchase: { firstPurchaseOffer: { type: "fixed", amount: 999 } },
	});
	expect(await service.quoteOrder(user.id, other.id)).toMatchObject({
		amount: 999,
		firstPurchase: true,
	});
	const legacy = await pack("legacy");
	expect(
		(
			await service.createOrder(user.id, {
				productId: legacy.id,
				provider: "test",
				idempotencyKey: "legacy",
			})
		).amount,
	).toBe(1499);
});

it("counts payments across catalog versions and does not restore eligibility after a full refund", async () => {
	const { user, service, pack } = await fixture();
	const product = await pack("once", { purchase: { maxPerUser: 1 } });
	const quote = await service.quoteOrder(user.id, product.id);
	const order = await service.createOrder(user.id, {
		productId: product.id,
		provider: "test",
		idempotencyKey: "once",
		quoteVersion: quote.quoteVersion,
	});
	await service.checkout(user.id, order.id);
	await service.confirmPayment(order.id, "verified");
	await service.confirmRefund(order.id, "refund");
	const next = await service.products.save({
		...product,
		name: "Renamed",
		amount: 1999,
		expectedVersion: 1,
	});
	expect(await service.quoteOrder(user.id, next.id)).toMatchObject({
		canPurchase: false,
		remaining: 0,
		purchaseCount: 1,
		reason: "limit_reached",
	});
});

it("releases only confirmed closed purchases, retains uncertain attempts and detects stale quotes", async () => {
	const { user, service, pack, adapter, inspect } = await fixture();
	const product = await pack("recover", { purchase: { maxPerUser: 2 } });
	const quote = await service.quoteOrder(user.id, product.id);
	const order = await service.createOrder(user.id, {
		productId: product.id,
		provider: "test",
		idempotencyKey: "pending",
		quoteVersion: quote.quoteVersion,
	});
	await service.checkout(user.id, order.id);
	await adapter.update({
		model: "businessOrder",
		where: [{ field: "id", value: order.id }],
		update: { expiresAt: new Date(0) },
	});
	expect((await service.reconcileCheckout(user.id, order.id)).state).toBe(
		"unknown",
	);
	const blocked = await service.quoteOrder(user.id, product.id);
	expect(blocked.reason).toBe("pending_order");
	inspect("closed");
	expect((await service.reconcileCheckout(user.id, order.id)).state).toBe(
		"closed",
	);
	const fresh = await service.quoteOrder(user.id, product.id);
	expect(fresh.canPurchase).toBe(true);
	await expect(
		service.createOrder(user.id, {
			productId: product.id,
			provider: "test",
			idempotencyKey: "stale",
			quoteVersion: blocked.quoteVersion,
		}),
	).rejects.toMatchObject({ body: { code: "PURCHASE_QUOTE_CHANGED" } });
	await service.createOrder(user.id, {
		productId: product.id,
		provider: "test",
		idempotencyKey: "fresh",
		quoteVersion: fresh.quoteVersion,
	});
});

it("validates discounts and rounds without integer overflow", () => {
	expect(() =>
		purchasePolicy({
			type: "credits",
			amount: 1,
			limits: {
				purchase: { firstPurchaseOffer: { type: "percent", percentOff: 99 } },
			},
		}),
	).toThrow();
	expect(() =>
		purchasePolicy({
			type: "credits",
			amount: 100,
			limits: {
				purchase: { firstPurchaseOffer: { type: "fixed", amount: 100 } },
			},
		}),
	).toThrow();
	expect(() =>
		purchasePolicy({
			type: "credits",
			amount: 100,
			limits: { purchase: { maxPerUser: 0 } },
		}),
	).toThrow();
	expect(
		purchasePolicy({
			type: "credits",
			amount: Number.MAX_SAFE_INTEGER,
			limits: {
				purchase: { firstPurchaseOffer: { type: "percent", percentOff: 1 } },
			},
		}).firstPurchaseOffer,
	).not.toBeNull();
});

it("allows exactly N successful purchases and fulfills a verified late payment once with review", async () => {
	const { user, service, pack, inspect } = await fixture();
	const product = await pack("twice", { purchase: { maxPerUser: 2 } });
	for (const id of ["one", "two"]) {
		const quote = await service.quoteOrder(user.id, product.id);
		const order = await service.createOrder(user.id, {
			productId: product.id,
			provider: "test",
			idempotencyKey: id,
			quoteVersion: quote.quoteVersion,
		});
		await service.checkout(user.id, order.id);
		await service.confirmPayment(order.id, id);
	}
	expect(await service.quoteOrder(user.id, product.id)).toMatchObject({
		purchaseCount: 2,
		remaining: 0,
		canPurchase: false,
	});
	const once = await pack("late", {
		purchase: {
			maxPerUser: 1,
			firstPurchaseOffer: { type: "fixed", amount: 999 },
		},
	});
	const initial = await service.quoteOrder(user.id, once.id);
	const old = await service.createOrder(user.id, {
		productId: once.id,
		provider: "test",
		idempotencyKey: "old",
		quoteVersion: initial.quoteVersion,
	});
	await service.checkout(user.id, old.id);
	inspect("closed");
	await service.reconcileCheckout(user.id, old.id);
	const fresh = await service.quoteOrder(user.id, once.id);
	const next = await service.createOrder(user.id, {
		productId: once.id,
		provider: "second",
		idempotencyKey: "next",
		quoteVersion: fresh.quoteVersion,
	});
	await service.checkout(user.id, next.id);
	await service.confirmPayment(next.id, "new-paid");
	expect(await service.confirmPayment(old.id, "late-paid")).toMatchObject({
		amount: 999,
		status: "fulfilled",
		reviewRequired: true,
	});
	expect(await service.confirmPayment(old.id, "late-paid")).toMatchObject({
		status: "fulfilled",
		reviewRequired: true,
	});
	expect(await service.quoteOrder(user.id, once.id)).toMatchObject({
		purchaseCount: 2,
		remaining: 0,
		canPurchase: false,
	});
});
