import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import type { BusinessOrder } from "@app/business";
import { describe, expect, it, vi } from "vitest";
import { createWaffoBusinessProvider, TaxCategory, WaffoPancake } from "../src";

const keys = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

function setup() {
	const order: BusinessOrder = {
		id: "order-123",
		referenceId: "user-123",
		checkoutKey: "key",
		provider: "waffo",
		productId: "product-123",
		productKey: "pro",
		parentOrderId: null,
		product: {
			id: "product-123",
			key: "pro",
			version: 1,
			name: "Pro",
			type: "credits",
			amount: 1999,
			currency: "USD",
			credits: 100,
			membershipDays: null,
			creditValidityDays: null,
			limits: {},
			published: true,
			createdAt: new Date().toISOString(),
		},
		amount: 1999,
		currency: "USD",
		status: "pending",
		providerOrderId: "cs_checkout",
		providerKey: null,
		checkoutURL: null,
		paymentId: null,
		paidAt: null,
		periodStart: null,
		periodEnd: null,
		refundedAmount: 0,
		reviewRequired: false,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 3600000),
		fulfilledAt: null,
	};
	const product = {
		id: "PROD_1234567890123456789012",
		status: "active",
		store: { id: "STO_test" },
	};
	const payment = {
		id: "PAY_test",
		orderId: "ORD_test",
		orderMerchantExternalId: order.id,
		status: "succeeded",
		createdAt: new Date().toISOString(),
		snapshotAmountDetails: {
			currency: "USD",
			subtotal: "19.99",
			taxAmount: "2.00",
			total: "21.99",
		},
		onetimeOrder: {
			id: "ORD_test",
			status: "completed",
			testMode: true,
			store: { id: "STO_test" },
			onetimeProduct: { id: "PROD_1234567890123456789012" },
		},
	};
	const payments: (typeof payment)[] = [payment];
	const fetcher = vi.fn<typeof fetch>();
	fetcher.mockImplementation(async (input, init) => {
		const path = new URL(String(input)).pathname;
		const headers = new Headers(init?.headers);
		const body = String(init?.body);
		const hash = createHash("sha256").update(body).digest("base64");
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(`POST\n${path}\n${headers.get("x-timestamp")}\n${hash}`),
				keys.publicKey,
				Buffer.from(headers.get("x-signature")!, "base64"),
			),
		).toBe(true);
		if (path.endsWith("create-session")) {
			expect(headers.get("x-idempotency-key")).toBe(order.id);
			return Response.json({
				data: {
					sessionId: "cs_checkout",
					checkoutUrl: "https://checkout.waffo.ai/test/checkout/cs_checkout",
					expiresAt: order.expiresAt.toISOString(),
				},
			});
		}
		expect(path).toBe("/v1/graphql");
		expect(headers.has("x-idempotency-key")).toBe(false);
		const request = JSON.parse(body) as {
			query: string;
			variables: Record<string, string>;
		};
		if (request.query.includes("onetimeProduct(id:"))
			return Response.json({ data: { onetimeProduct: product } });
		expect(request.variables.ref).toBe(order.id);
		return Response.json({ data: { payments } });
	});
	const client = new WaffoPancake({
		merchantId: "MER_1234567890123456789012",
		privateKey: keys.privateKey,
		webhookPublicKey: keys.publicKey,
		fetch: fetcher,
	});
	const options = {
		client,
		productId: product.id,
		storeId: product.store.id,
		environment: "test" as const,
		taxCategory: TaxCategory.SaaS,
		returnURL: "https://app.example/return?locale=zh#result",
	};
	const provider = createWaffoBusinessProvider(options);
	return {
		provider,
		options,
		order,
		payment,
		payments,
		product,
		fetcher,
		client,
	};
}

/** @see https://docs.waffo.ai/api-reference/endpoints/orders/create-checkout-session */
describe("Waffo Business adapter", () => {
	it("signs checkout with an idempotency key, decimal price and merchant order binding", async () => {
		const { provider, order, fetcher } = setup();
		await expect(provider.createCheckout(order)).resolves.toMatchObject({
			providerOrderId: "cs_checkout",
		});
		const body = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
		expect(body).toMatchObject({
			productId: "PROD_1234567890123456789012",
			currency: "USD",
			priceSnapshot: { amount: "19.99", taxCategory: "saas" },
			orderMerchantExternalId: order.id,
			metadata: { businessOrderId: order.id },
		});
		expect(body).not.toHaveProperty("productType");
		expect(body.priceSnapshot).not.toHaveProperty("taxIncluded");
		const url = new URL(body.successUrl);
		expect(url.searchParams.get("orderId")).toBe(order.id);
		expect(url.searchParams.get("locale")).toBe("zh");
		expect(url.hash).toBe("#result");
		order.currency = "JPY";
		await provider.createCheckout(order);
		expect(
			JSON.parse(String(fetcher.mock.calls[3]![1]?.body)).priceSnapshot.amount,
		).toBe("1999");
	});
	it("rejects inactive/foreign products, invalid amounts, currencies and expiry before creating checkout", async () => {
		for (const patch of [
			{ amount: 0 },
			{ amount: 1.5 },
			{ currency: "KWD" },
			{ currency: "usd" },
			{ expiresAt: new Date(0) },
			{ expiresAt: new Date(Date.now() + 2 * 86400000) },
		]) {
			const { provider, order, fetcher } = setup();
			await expect(
				provider.createCheckout({ ...order, ...patch }),
			).rejects.toThrow();
			expect(fetcher).not.toHaveBeenCalled();
		}
		const { provider, order, product, fetcher } = setup();
		product.store.id = "STO_foreign";
		await expect(provider.createCheckout(order)).rejects.toThrow(
			"one-time product",
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("requires a trusted HTTPS return URL", () => {
		const { options } = setup();
		for (const returnURL of [
			"http://localhost:3000/return",
			"https://user:pass@app.example",
			"https://app.example?orderId=other",
			"https://app.example?reference=other",
		])
			expect(() =>
				createWaffoBusinessProvider({ ...options, returnURL }),
			).toThrow();
	});
	it("reconciles a completed payment including tax and permits late delivery", async () => {
		const { provider, order, payment } = setup();
		order.expiresAt = new Date(0);
		await expect(
			provider.verifyPayment({ order, reference: "cs_checkout" }),
		).resolves.toEqual({
			paymentId: payment.id,
			providerOrderId: "cs_checkout",
			amount: 1999,
			currency: "USD",
			paidAt: new Date(payment.createdAt),
		});
	});
	it("rejects a wrong checkout reference without querying Waffo", async () => {
		const { provider, order, fetcher } = setup();
		await expect(
			provider.verifyPayment({ order, reference: "cs_other" }),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects unpaid, foreign, recurring, wrong-environment and tampered payments", async () => {
		const mutations: ((
			payment: ReturnType<typeof setup>["payment"],
		) => void)[] = [
			(p) => {
				p.status = "pending";
			},
			(p) => {
				p.orderMerchantExternalId = "other";
			},
			(p) => {
				p.orderId = "ORD_other";
			},
			(p) => {
				p.onetimeOrder.status = "pending";
			},
			(p) => {
				p.onetimeOrder.testMode = false;
			},
			(p) => {
				p.onetimeOrder.store.id = "STO_other";
			},
			(p) => {
				p.onetimeOrder.onetimeProduct.id = "PROD_other";
			},
			(p) => {
				p.snapshotAmountDetails.currency = "EUR";
			},
			(p) => {
				p.snapshotAmountDetails.subtotal = "19.98";
			},
			(p) => {
				p.snapshotAmountDetails.total = "19.99";
			},
			(p) => {
				p.snapshotAmountDetails.taxAmount = "-2.00";
			},
			(p) => {
				p.snapshotAmountDetails.subtotal = "19.9901";
			},
			(p) => {
				p.createdAt = "invalid";
			},
		];
		for (const mutate of mutations) {
			const { provider, order, payment } = setup();
			mutate(payment);
			await expect(
				provider.verifyPayment({ order, reference: "cs_checkout" }),
			).rejects.toThrow();
		}
		const { provider, order, fetcher } = setup();
		fetcher.mockResolvedValueOnce(
			Response.json({ data: { payments: [{ onetimeOrder: null }] } }),
		);
		await expect(
			provider.verifyPayment({ order, reference: "cs_checkout" }),
		).rejects.toThrow();
	});
	it("rejects missing, duplicate and partially errored query results", async () => {
		const { provider, order, payments, payment, fetcher } = setup();
		payments.push(payment);
		await expect(
			provider.verifyPayment({ order, reference: "cs_checkout" }),
		).rejects.toThrow("exactly one");
		payments.length = 0;
		await expect(
			provider.verifyPayment({ order, reference: "cs_checkout" }),
		).rejects.toThrow("exactly one");
		fetcher.mockResolvedValueOnce(
			Response.json({
				data: { payments: [payment] },
				errors: [{ message: "partial response" }],
			}),
		);
		await expect(
			provider.verifyPayment({ order, reference: "cs_checkout" }),
		).rejects.toThrow();
	});
});

/** @see https://docs.waffo.ai/api-reference/webhooks */
it("verifies raw RSA webhooks, environment, store and replay window before returning an order", async () => {
	const { provider } = setup();
	function request(
		patch: Record<string, unknown> = {},
		age = 0,
		corrupt = false,
	) {
		const body = JSON.stringify(
			{
				id: "delivery",
				eventType: "order.completed",
				mode: "test",
				storeId: "STO_test",
				data: { orderMerchantExternalId: "order-123" },
				...patch,
			},
			null,
			2,
		);
		const time = Date.now() - age;
		const signature = sign(
			"RSA-SHA256",
			Buffer.from(`${time}.${body}`),
			keys.privateKey,
		).toString("base64");
		return new Request("https://app.example/webhook", {
			method: "POST",
			body: corrupt ? body + " " : body,
			headers: { "x-waffo-signature": `t=${time},v1=${signature}` },
		});
	}
	await expect(provider.verifyWebhook(request())).resolves.toEqual({
		orderId: "order-123",
	});
	await expect(
		provider.verifyWebhook(request({ eventType: "refund.succeeded" })),
	).resolves.toBeNull();
	await expect(
		provider.verifyWebhook(request({ data: {} })),
	).resolves.toBeNull();
	for (const delivery of [
		request({ mode: "prod" }),
		request({ storeId: "STO_other" }),
		request({ data: { orderMerchantExternalId: 123 } }),
		request({}, 3600000),
		request({}, -120000),
		request({}, 0, true),
		new Request("https://app.example/webhook", { method: "POST", body: "{}" }),
	])
		await expect(provider.verifyWebhook(delivery)).rejects.toThrow();
});
