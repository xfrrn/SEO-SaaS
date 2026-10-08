import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BusinessOrder } from "@app/auth-sdk/business";
import { createCreditsService } from "@app/auth-sdk/credits";
import { createProductService } from "@app/auth-sdk/subscription";
import { getMigrations } from "better-auth/db/migration";
import { POST } from "../app/api/payments/webhook/route.ts";
import { closeAuth, getAuth } from "../lib/auth.ts";

test("PayPal webhook fulfills a real abandoned checkout exactly once and rejects invalid deliveries", async (t) => {
	const database = fileURLToPath(
		new URL(
			`../.cache/payment-webhook-${randomUUID()}.sqlite`,
			import.meta.url,
		),
	);
	const environment = {
		NODE_ENV: "test",
		DATABASE_URL: "",
		DASHBOARD_SQLITE_PATH: database,
		BETTER_AUTH_URL: "https://app.example.test",
		BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
		PAYMENT_PROVIDER: "paypal",
		PAYPAL_CLIENT_ID: "test-client",
		PAYPAL_CLIENT_SECRET: "test-secret",
		PAYPAL_WEBHOOK_ID: "test-webhook",
		PAYPAL_ENVIRONMENT: "sandbox",
		APP_MONITOR_ENABLED: "true",
		APP_MONITOR_SITE_ID: "webhook-test",
		APP_MONITOR_ENVIRONMENT: "development",
		APP_MONITOR_ENDPOINT: "https://collector.example/v1/server-events",
		APP_MONITOR_TOKEN: randomUUID(),
		APP_MONITOR_ORIGINS_JSON: '["https://app.example.test"]',
		APP_MONITOR_ALLOWED_PATHS_JSON: "[]",
		SMTP_HOST: "",
		SMTP_PORT: "",
		SMTP_SECURE: "",
		SMTP_USER: "",
		SMTP_PASSWORD: "",
		EMAIL_FROM: "",
	};
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, environment);
	let localOrderId = "";
	let captures = 0;
	const reported: Record<string, unknown>[] = [];
	const paidAt = new Date().toISOString();
	const amount = { currency_code: "USD", value: "9.99" };
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin === "https://collector.example") {
				reported.push(...JSON.parse(String(init?.body)).events);
				return Response.json({ accepted: 1, duplicates: 0 });
			}
			assert.equal(url.origin, "https://api-m.sandbox.paypal.com");
			if (url.pathname === "/v1/oauth2/token")
				return Response.json({ access_token: "test-token" });
			if (url.pathname === "/v1/notifications/verify-webhook-signature") {
				const body = JSON.parse(String(init?.body)) as {
					transmission_sig: string;
					webhook_id: string;
				};
				assert.equal(body.webhook_id, "test-webhook");
				return Response.json({
					verification_status:
						body.transmission_sig === "valid-test-signature"
							? "SUCCESS"
							: "FAILURE",
				});
			}
			if (url.pathname === "/v2/checkout/orders") {
				assert.equal(init?.method, "POST");
				const body = JSON.parse(String(init?.body)) as {
					purchase_units: { custom_id: string; amount: typeof amount }[];
				};
				assert.equal(body.purchase_units[0]?.custom_id, localOrderId);
				assert.deepEqual(body.purchase_units[0]?.amount, amount);
				return Response.json({
					id: "PAYPAL123",
					status: "CREATED",
					links: [
						{
							rel: "payer-action",
							href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL123",
						},
					],
				});
			}
			assert.ok(
				[
					"/v2/checkout/orders/PAYPAL123",
					"/v2/checkout/orders/PAYPAL999",
					"/v2/checkout/orders/PAYPAL123/capture",
				].includes(url.pathname),
			);
			if (url.pathname.endsWith("/capture")) {
				assert.equal(init?.method, "POST");
				captures++;
				assert.equal(
					new Headers(init?.headers).get("paypal-request-id"),
					`capture-${localOrderId}`,
				);
			}
			return Response.json({
				id: url.pathname.includes("PAYPAL999") ? "PAYPAL999" : "PAYPAL123",
				status: captures ? "COMPLETED" : "APPROVED",
				purchase_units: [
					{
						custom_id: localOrderId,
						reference_id: localOrderId,
						amount,
						...(captures
							? {
									payments: {
										captures: [
											{
												id: "CAPTURE123",
												status: "COMPLETED",
												amount,
												create_time: paidAt,
											},
										],
									},
								}
							: {}),
					},
				],
			});
		},
	);
	function delivery(
		reference = "PAYPAL123",
		signature = "valid-test-signature",
	) {
		return new Request(`${environment.BETTER_AUTH_URL}/api/payments/webhook`, {
			method: "POST",
			headers: {
				"paypal-auth-algo": "SHA256withRSA",
				"paypal-cert-url": "https://api.paypal.com/cert/test",
				"paypal-transmission-id": "delivery-123",
				"paypal-transmission-sig": signature,
				"paypal-transmission-time": paidAt,
			},
			body: JSON.stringify({
				id: "EVENT123",
				event_type: "CHECKOUT.ORDER.APPROVED",
				resource: { id: reference },
			}),
		});
	}
	try {
		const auth = getAuth();
		await (await getMigrations(auth.options)).runMigrations();
		const { adapter } = await auth.$context;
		const password = randomUUID();
		const { user } = await auth.api.createUser({
			body: {
				name: "Buyer",
				email: "buyer@example.test",
				password,
				role: "user",
			},
		});
		const signed = await auth.api.signInEmail({
			body: { email: user.email, password },
			returnHeaders: true,
		});
		const headers = new Headers({ cookie: signed.headers.get("set-cookie")! });
		const product = await createProductService(adapter).save({
			key: "webhook-credits",
			expectedVersion: 0,
			name: "Credits",
			type: "credits",
			amount: 999,
			currency: "USD",
			credits: 80,
			published: true,
		});
		const order = await auth.api.createBusinessOrder({
			headers,
			body: {
				productId: product.id,
				provider: "paypal",
				idempotencyKey: "test-checkout",
			},
		});
		localOrderId = order.id;
		const checkout = await auth.api.checkoutBusinessOrder({
			headers,
			body: { orderId: order.id },
		});
		assert.equal(checkout.providerOrderId, "PAYPAL123");
		const credits = createCreditsService(adapter);
		assert.equal((await credits.balance(user.id)).balance, 0);
		assert.equal(
			(await POST(delivery("PAYPAL123", "invalid-signature"))).status,
			503,
		);
		assert.equal((await POST(delivery("PAYPAL999"))).status, 503);
		assert.equal(captures, 0);
		assert.equal((await credits.balance(user.id)).balance, 0);
		// No browser completion call: the signed notification alone captures and fulfills.
		assert.equal((await POST(delivery())).status, 200);
		assert.equal((await POST(delivery())).status, 200);
		assert.equal(captures, 1);
		assert.equal((await credits.balance(user.id)).balance, 80);
		assert.equal(await adapter.count({ model: "creditEntry" }), 1);
		assert.equal(await adapter.count({ model: "businessPaymentEvent" }), 1);
		await Promise.all([
			POST(delivery()),
			auth.api.completeBusinessOrder({ headers, body: { orderId: order.id } }),
		]);
		assert.equal(await adapter.count({ model: "businessMonitorEvent" }), 1);
		assert.equal(reported.length, 0);
		await auth.api.runMonitorDelivery();
		assert.equal(reported.length, 1);
		assert.equal(reported[0].event_type, "payment_confirmed");
		assert.deepEqual(reported[0].props, { amount: 999, currency: "USD" });
		assert.equal(reported[0].occurred_at, paidAt);
		const fulfilled = await adapter.findOne<BusinessOrder>({
			model: "businessOrder",
			where: [{ field: "id", value: order.id }],
		});
		assert.equal(fulfilled?.status, "fulfilled");
		assert.equal(fulfilled?.paymentId, "CAPTURE123");
		assert.ok(fulfilled?.fulfilledAt);
	} finally {
		await closeAuth();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const suffix of ["", "-wal", "-shm"])
			await rm(database + suffix, { force: true });
	}
});
