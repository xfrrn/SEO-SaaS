import type { BusinessOrder } from "@app/business";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createStripeBusinessProvider } from "../src/business";

function setup() {
	const stripeClient = new Stripe("sk_test_business_adapter");
	const order: BusinessOrder = {
		id: "order-123",
		referenceId: "user-123",
		checkoutKey: "checkout-key",
		provider: "stripe",
		productId: "product-123",
		productKey: "pro",
		parentOrderId: null,
		product: {
			id: "product-123",
			key: "pro",
			version: 1,
			name: "Pro package",
			type: "bundle",
			amount: 1999,
			currency: "USD",
			credits: 100,
			membershipDays: 30,
			creditValidityDays: null,
			limits: {},
			published: true,
			createdAt: new Date().toISOString(),
		},
		amount: 1999,
		currency: "USD",
		status: "pending",
		providerOrderId: "cs_test_business",
		providerKey: null,
		checkoutURL: null,
		paymentId: null,
		paidAt: null,
		periodStart: null,
		periodEnd: null,
		refundedAmount: 0,
		reviewRequired: false,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		fulfilledAt: null,
	};
	const charge = {
		id: "ch_paid",
		status: "succeeded",
		paid: true,
		created: 1_800_000_120,
	};
	const payment = {
		id: "pi_paid",
		status: "succeeded",
		amount_received: order.amount,
		currency: "usd",
		metadata: { businessOrderId: order.id },
		latest_charge: charge,
	};
	const session = {
		id: order.providerOrderId,
		client_reference_id: order.id,
		metadata: { businessOrderId: order.id },
		mode: "payment",
		status: "complete",
		payment_status: "paid",
		amount_total: order.amount,
		currency: "usd",
		payment_intent: payment,
		created: 1_800_000_000,
		url: "https://checkout.stripe.com/c/pay/cs_test_business",
	};
	const response =
		session as unknown as Stripe.Response<Stripe.Checkout.Session>;
	const create = vi
		.spyOn(stripeClient.checkout.sessions, "create")
		.mockResolvedValue(response);
	const retrieve = vi
		.spyOn(stripeClient.checkout.sessions, "retrieve")
		.mockResolvedValue(response);
	const provider = createStripeBusinessProvider({
		stripeClient,
		returnURL: "https://app.example.com/paid?view=order#result",
		cancelURL: "https://app.example.com/catalog?view=plans#pricing",
	});
	return {
		order,
		session,
		payment,
		charge,
		create,
		retrieve,
		provider,
		stripeClient,
	};
}

/** @see https://docs.stripe.com/api/checkout/sessions/create */
describe("Stripe Business adapter", () => {
	it("uses persisted snapshots, stable idempotency and literal session substitution across retries", async () => {
		const { order, create, provider } = setup();
		const result = await provider.createCheckout(order);
		await provider.createCheckout(order);
		expect(result).toEqual({
			providerOrderId: "cs_test_business",
			url: "https://checkout.stripe.com/c/pay/cs_test_business",
		});
		expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
		expect(create).toHaveBeenCalledWith(
			{
				mode: "payment",
				client_reference_id: order.id,
				metadata: { businessOrderId: order.id },
				payment_intent_data: { metadata: { businessOrderId: order.id } },
				adaptive_pricing: { enabled: false },
				line_items: [
					{
						quantity: 1,
						price_data: {
							currency: "usd",
							unit_amount: 1999,
							product_data: { name: "Pro package" },
						},
					},
				],
				expires_at: Math.floor(order.expiresAt.getTime() / 1000),
				success_url:
					"https://app.example.com/paid?view=order&orderId=order-123&reference={CHECKOUT_SESSION_ID}#result",
				cancel_url:
					"https://app.example.com/catalog?view=plans&orderId=order-123#pricing",
			},
			{ idempotencyKey: order.id },
		);
	});

	/** @see https://docs.stripe.com/currencies#special-cases */
	it.each([
		["ISK", 5, 500],
		["UGX", 5, 500],
		["MGA", 500, 5],
		["JPY", 5, 5],
		["HUF", 501, 501],
		["TWD", 501, 501],
	])("maps ISO minor units to Stripe %s amounts and reconciles back without changing the order", async (currency, amount, stripeAmount) => {
		const { order, create, provider, session, payment } = setup();
		order.currency = String(currency);
		order.amount = Number(amount);
		session.currency = payment.currency = String(currency).toLowerCase();
		session.amount_total = payment.amount_received = Number(stripeAmount);
		await provider.createCheckout(order);
		expect(
			create.mock.calls[0]?.[0]?.line_items?.[0]?.price_data?.unit_amount,
		).toBe(stripeAmount);
		await expect(
			provider.verifyPayment({ order, reference: "cs_test_business" }),
		).resolves.toMatchObject({
			amount,
			currency,
		});
		session.amount_total = Number(stripeAmount) + 1;
		await expect(
			provider.verifyPayment({ order, reference: "cs_test_business" }),
		).rejects.toThrow("do not match");
		session.amount_total = Number(stripeAmount);
		payment.amount_received = Number(stripeAmount) + 1;
		await expect(
			provider.verifyPayment({ order, reference: "cs_test_business" }),
		).rejects.toThrow("do not match");
	});

	/** @see https://docs.stripe.com/currencies */
	it.each([
		["MGA", 501],
		["ISK", Number.MAX_SAFE_INTEGER],
		["UGX", Number.MAX_SAFE_INTEGER],
		...["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND", "CLF", "UYW"].map(
			(currency) => [currency, 1000],
		),
	])("rejects unsupported or inexact %s conversion before contacting Stripe", async (currency, amount) => {
		const { order, create, retrieve, provider } = setup();
		Object.assign(order, {
			currency: String(currency),
			amount: Number(amount),
		});
		await expect(provider.createCheckout(order)).rejects.toThrow();
		await expect(
			provider.verifyPayment({ order, reference: "cs_test_business" }),
		).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
		expect(retrieve).not.toHaveBeenCalled();
	});

	it("rejects invalid amounts, deadlines and unsafe configured redirects before calling Stripe", async () => {
		const { order, provider, create, stripeClient } = setup();
		for (const amount of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(
				provider.createCheckout({ ...order, amount }),
			).rejects.toThrow("positive amount");
		}
		for (const expiresAt of [
			new Date(Date.now() + 29 * 60_000),
			new Date(Date.now() + 25 * 60 * 60_000),
			new Date(Number.NaN),
		]) {
			await expect(
				provider.createCheckout({ ...order, expiresAt }),
			).rejects.toThrow("30 minutes to 24 hours");
		}
		for (const returnURL of [
			"javascript:alert(1)",
			"http://app.example.com/paid",
			"https://user:pass@app.example.com/paid",
			"https://app.example.com/paid?reference=wrong",
		]) {
			expect(() =>
				createStripeBusinessProvider({
					stripeClient,
					returnURL,
					cancelURL: "https://app.example.com/cancel",
				}),
			).toThrow();
		}
		expect(create).not.toHaveBeenCalled();
	});

	it("queries Stripe and returns a stable verified payment even after local order expiry", async () => {
		const { order, provider, retrieve } = setup();
		order.expiresAt = new Date(0);
		const input = { order, reference: "cs_test_business" };
		expect(await provider.verifyPayment(input)).toEqual({
			paymentId: "pi_paid",
			providerOrderId: "cs_test_business",
			amount: 1999,
			currency: "USD",
			paidAt: new Date(1_800_000_120_000),
		});
		expect(await provider.verifyPayment(input)).toEqual(
			await provider.verifyPayment(input),
		);
		expect(retrieve).toHaveBeenCalledWith("cs_test_business", {
			expand: ["payment_intent.latest_charge"],
		});
	});

	it("rejects another checkout before querying and rejects mismatched or incomplete provider payments", async () => {
		const { order, provider, retrieve } = setup();
		await expect(
			provider.verifyPayment({ order, reference: "cs_test_other" }),
		).rejects.toThrow("does not belong");
		expect(retrieve).not.toHaveBeenCalled();
		const changes = [
			{ id: "cs_test_other" },
			{ client_reference_id: "another-order" },
			{ metadata: { businessOrderId: "another-order" } },
			{ mode: "subscription" },
			{ status: "open" },
			{ payment_status: "unpaid" },
			{ payment_status: "no_payment_required" },
			{ amount_total: 1 },
			{ currency: "eur" },
			{ payment_intent: null },
		];
		for (const change of changes) {
			const current = setup();
			Object.assign(current.session, change);
			await expect(
				current.provider.verifyPayment({
					order: current.order,
					reference: "cs_test_business",
				}),
			).rejects.toThrow();
		}
		for (const change of [
			{ status: "processing" },
			{ amount_received: 1 },
			{ currency: "eur" },
			{ metadata: { businessOrderId: "another-order" } },
			{ latest_charge: null },
		]) {
			const current = setup();
			Object.assign(current.payment, change);
			await expect(
				current.provider.verifyPayment({
					order: current.order,
					reference: "cs_test_business",
				}),
			).rejects.toThrow();
		}
		for (const change of [
			{ paid: false },
			{ status: "pending" },
			{ created: Number.NaN },
		]) {
			const current = setup();
			Object.assign(current.charge, change);
			await expect(
				current.provider.verifyPayment({
					order: current.order,
					reference: "cs_test_business",
				}),
			).rejects.toThrow();
		}
	});
});
