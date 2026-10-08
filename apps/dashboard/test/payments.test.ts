import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";
import Stripe from "stripe";
import { readPaymentConfig } from "../lib/payment-config.ts";
import { createPayments } from "../lib/payments.ts";

const stripeEnvironment = {
	PAYMENT_PROVIDER: "stripe",
	STRIPE_SECRET_KEY: "sk_test_dashboard_webhooks",
	STRIPE_WEBHOOK_SECRET: "whsec_test_dashboard_webhooks",
};
const paypalEnvironment = {
	PAYMENT_PROVIDER: "paypal",
	PAYPAL_CLIENT_ID: "test-client",
	PAYPAL_CLIENT_SECRET: "test-secret",
	PAYPAL_WEBHOOK_ID: "test-webhook",
	PAYPAL_ENVIRONMENT: "sandbox",
};

function configure(t: TestContext, values: Record<string, string>) {
	const keys = new Set([
		...Object.keys(stripeEnvironment),
		...Object.keys(paypalEnvironment),
	]);
	const previous = Object.fromEntries(
		[...keys].map((key) => [key, process.env[key]]),
	);
	for (const key of keys) delete process.env[key];
	Object.assign(process.env, values);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

test("payment configuration enables only the selected channel and requires its credentials", (t) => {
	assert.equal(readPaymentConfig({}), undefined);
	assert.equal(readPaymentConfig({ PAYMENT_PROVIDER: "none" }), undefined);
	assert.deepEqual(readPaymentConfig(stripeEnvironment), {
		provider: "stripe",
		secretKey: stripeEnvironment.STRIPE_SECRET_KEY,
		webhookSecret: stripeEnvironment.STRIPE_WEBHOOK_SECRET,
	});
	assert.deepEqual(readPaymentConfig(paypalEnvironment), {
		provider: "paypal",
		environment: "sandbox",
		clientId: "test-client",
		clientSecret: "test-secret",
		webhookId: "test-webhook",
	});
	for (const input of [
		{ PAYMENT_PROVIDER: "unknown" },
		{ ...stripeEnvironment, STRIPE_SECRET_KEY: "" },
		{ ...stripeEnvironment, STRIPE_WEBHOOK_SECRET: "" },
		{ ...paypalEnvironment, PAYPAL_CLIENT_ID: "" },
		{ ...paypalEnvironment, PAYPAL_CLIENT_SECRET: "" },
		{ ...paypalEnvironment, PAYPAL_WEBHOOK_ID: "" },
		{ ...paypalEnvironment, PAYPAL_ENVIRONMENT: "test" },
	])
		assert.throws(() => readPaymentConfig(input));
	configure(t, { PAYMENT_PROVIDER: "none" });
	assert.deepEqual(createPayments("https://app.example.com"), {
		providers: {},
		webhook: undefined,
	});
});

test("Stripe webhook verifies signatures before selecting paid checkout metadata", async (t) => {
	configure(t, stripeEnvironment);
	const payments = createPayments("https://app.example.com");
	assert.deepEqual(Object.keys(payments.providers), ["stripe"]);
	assert.ok(payments.webhook);
	const stripe = new Stripe(stripeEnvironment.STRIPE_SECRET_KEY);
	const cryptoProvider = Stripe.createNodeCryptoProvider();
	function request(
		type = "checkout.session.completed",
		paid = "paid",
		secret = stripeEnvironment.STRIPE_WEBHOOK_SECRET,
	) {
		const payload = JSON.stringify({
			id: "evt_test_checkout",
			object: "event",
			type,
			data: {
				object: {
					id: "cs_test_checkout",
					object: "checkout.session",
					payment_status: paid,
					metadata: { businessOrderId: "business-order-123" },
				},
			},
		});
		const timestamp = Math.floor(Date.now() / 1000);
		return new Request("https://app.example.com/api/payments/webhook", {
			method: "POST",
			body: payload,
			headers: {
				"stripe-signature": stripe.webhooks.generateTestHeaderString({
					payload,
					secret,
					timestamp,
					scheme: "v1",
					cryptoProvider,
					signature: cryptoProvider.computeHMACSignature(
						`${timestamp}.${payload}`,
						secret,
					),
				}),
			},
		});
	}
	const receipt = {
		provider: "stripe",
		orderId: "business-order-123",
		reference: "cs_test_checkout",
	};
	assert.deepEqual(await payments.webhook(request()), receipt);
	assert.deepEqual(
		await payments.webhook(request("checkout.session.async_payment_succeeded")),
		receipt,
	);
	assert.equal(await payments.webhook(request("customer.created")), null);
	assert.equal(
		await payments.webhook(request("checkout.session.completed", "unpaid")),
		null,
	);
	await assert.rejects(
		payments.webhook(
			request("checkout.session.completed", "paid", "whsec_wrong"),
		),
	);
	await assert.rejects(
		payments.webhook(request("customer.created", "paid", "whsec_wrong")),
	);
	await assert.rejects(
		payments.webhook(
			new Request("https://app.example.com/api/payments/webhook", {
				method: "POST",
				body: "{}",
			}),
		),
		/Missing payment signature/,
	);
});

function paypalRequest(eventType: string, resource: Record<string, unknown>) {
	return new Request("https://app.example.com/api/payments/webhook", {
		method: "POST",
		headers: {
			"paypal-auth-algo": "SHA256withRSA",
			"paypal-cert-url": "https://api.paypal.com/cert/test",
			"paypal-transmission-id": "delivery-id",
			"paypal-transmission-sig": "test-signature",
			"paypal-transmission-time": "2026-10-08T00:00:00Z",
		},
		body: JSON.stringify({ id: "event-id", event_type: eventType, resource }),
	});
}

function mockPayPal(t: TestContext, verificationStatus = "SUCCESS") {
	const calls: { url: string; body: unknown }[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			calls.push({
				url,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			assert.ok(url.startsWith("https://api-m.sandbox.paypal.com/"));
			if (url.endsWith("/v1/oauth2/token"))
				return Response.json({ access_token: "test-token" });
			if (url.endsWith("/v1/notifications/verify-webhook-signature"))
				return Response.json({ verification_status: verificationStatus });
			assert.equal(
				url,
				"https://api-m.sandbox.paypal.com/v2/checkout/orders/PAYPAL123",
			);
			assert.equal(init?.method, "GET");
			return Response.json({
				id: "PAYPAL123",
				status: "APPROVED",
				purchase_units: [
					{
						custom_id: "authoritative-local-order",
						reference_id: "authoritative-local-order",
					},
				],
			});
		},
	);
	return calls;
}

test("PayPal verifies deliveries then queries authoritative order ownership for approval and capture", async (t) => {
	configure(t, paypalEnvironment);
	const calls = mockPayPal(t);
	const payments = createPayments("https://app.example.com");
	assert.deepEqual(Object.keys(payments.providers), ["paypal"]);
	assert.ok(payments.webhook);
	const receipt = {
		provider: "paypal",
		orderId: "authoritative-local-order",
		reference: "PAYPAL123",
	};
	assert.deepEqual(
		await payments.webhook(
			paypalRequest("CHECKOUT.ORDER.APPROVED", {
				id: "PAYPAL123",
				custom_id: "do-not-trust-webhook-custom-id",
			}),
		),
		receipt,
	);
	assert.deepEqual(
		await payments.webhook(
			paypalRequest("PAYMENT.CAPTURE.COMPLETED", {
				id: "CAPTURE123",
				custom_id: "do-not-trust-webhook-custom-id",
				supplementary_data: { related_ids: { order_id: "PAYPAL123" } },
			}),
		),
		receipt,
	);
	const paths = calls
		.filter((call) => !call.url.endsWith("/v1/oauth2/token"))
		.map((call) => new URL(call.url).pathname);
	assert.deepEqual(paths, [
		"/v1/notifications/verify-webhook-signature",
		"/v2/checkout/orders/PAYPAL123",
		"/v1/notifications/verify-webhook-signature",
		"/v2/checkout/orders/PAYPAL123",
	]);
	const verificationBody = calls.find((call) =>
		call.url.endsWith("/verify-webhook-signature"),
	)?.body;
	assert.equal(typeof verificationBody, "string");
	assert.match(String(verificationBody), /"webhook_id":"test-webhook"/);
	assert.match(String(verificationBody), /"transmission_sig":"test-signature"/);
});

test("PayPal rejects failed verification without querying an order or trusting unrelated events", async (t) => {
	configure(t, paypalEnvironment);
	const calls = mockPayPal(t, "FAILURE");
	const payments = createPayments("https://app.example.com");
	assert.ok(payments.webhook);
	for (const eventType of [
		"CHECKOUT.ORDER.APPROVED",
		"CUSTOMER.DISPUTE.CREATED",
	]) {
		await assert.rejects(
			payments.webhook(paypalRequest(eventType, { id: "PAYPAL123" })),
		);
	}
	assert.ok(calls.every((call) => !call.url.includes("/v2/checkout/orders/")));
});

test("PayPal ignores verified unrelated events and rejects malformed payment references before lookup", async (t) => {
	configure(t, paypalEnvironment);
	const calls = mockPayPal(t);
	const payments = createPayments("https://app.example.com");
	assert.ok(payments.webhook);
	assert.equal(
		await payments.webhook(
			paypalRequest("CUSTOMER.DISPUTE.CREATED", { id: "PAYPAL123" }),
		),
		null,
	);
	await assert.rejects(
		payments.webhook(
			paypalRequest("PAYMENT.CAPTURE.COMPLETED", { id: "CAPTURE123" }),
		),
		/Missing PayPal order reference/,
	);
	assert.ok(calls.every((call) => !call.url.includes("/v2/checkout/orders/")));
});
