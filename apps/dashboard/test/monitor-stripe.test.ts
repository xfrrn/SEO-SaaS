import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProductService } from "@app/auth-sdk/subscription";
import { getMigrations } from "better-auth/db/migration";
import Stripe from "stripe";
import { POST } from "../app/api/payments/webhook/route.ts";
import { closeAuth, getAuth } from "../lib/auth.ts";

test("signed Stripe callback and browser verification produce one monitoring payment", async (t) => {
	const database = fileURLToPath(
		new URL(`../.cache/monitor-stripe-${randomUUID()}.sqlite`, import.meta.url),
	);
	const environment = {
		NODE_ENV: "test",
		DATABASE_URL: "",
		DASHBOARD_SQLITE_PATH: database,
		BETTER_AUTH_URL: "https://app.example.test",
		BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
		PAYMENT_PROVIDER: "stripe",
		STRIPE_SECRET_KEY: "sk_test_local_monitor",
		STRIPE_WEBHOOK_SECRET: "whsec_local_monitor",
		SMTP_HOST: "",
		SMTP_PORT: "",
		SMTP_SECURE: "",
		SMTP_USER: "",
		SMTP_PASSWORD: "",
		EMAIL_FROM: "",
		APP_MONITOR_ENABLED: "true",
		APP_MONITOR_SITE_ID: "stripe-test",
		APP_MONITOR_ENVIRONMENT: "development",
		APP_MONITOR_ENDPOINT: "https://collector.example/v1/server-events",
		APP_MONITOR_TOKEN: randomUUID(),
		APP_MONITOR_ORIGINS_JSON: '["https://app.example.test"]',
		APP_MONITOR_ALLOWED_PATHS_JSON: "[]",
	};
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, environment);
	t.after(async () => {
		await closeAuth();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const suffix of ["", "-wal", "-shm"])
			await rm(database + suffix, { force: true });
	});
	const stripe = new Stripe(environment.STRIPE_SECRET_KEY);
	const prototype = Object.getPrototypeOf(
		stripe.checkout.sessions,
	) as typeof stripe.checkout.sessions;
	let orderId = "";
	const paidSeconds = Math.floor(Date.now() / 1000);
	const checkout = () =>
		({
			id: "cs_test_monitor",
			url: "https://checkout.stripe.com/c/pay/cs_test_monitor",
			mode: "payment",
			status: "complete",
			payment_status: "paid",
			client_reference_id: orderId,
			metadata: { businessOrderId: orderId },
			amount_total: 990,
			currency: "usd",
			payment_intent: {
				id: "pi_test_monitor",
				status: "succeeded",
				amount_received: 990,
				currency: "usd",
				metadata: { businessOrderId: orderId },
				latest_charge: {
					id: "ch_test_monitor",
					status: "succeeded",
					paid: true,
					created: paidSeconds,
				},
			},
		}) as unknown as Stripe.Response<Stripe.Checkout.Session>;
	t.mock.method(prototype, "create", async () => checkout());
	t.mock.method(prototype, "retrieve", async () => checkout());
	const reported: Record<string, unknown>[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			assert.equal(String(input), environment.APP_MONITOR_ENDPOINT);
			reported.push(...JSON.parse(String(init?.body)).events);
			return Response.json({ accepted: 1, duplicates: 0 });
		},
	);
	const auth = getAuth();
	await (await getMigrations(auth.options)).runMigrations();
	const { adapter } = await auth.$context;
	const password = randomUUID();
	const { user } = await auth.api.createUser({
		body: {
			name: "Buyer",
			email: "stripe@example.test",
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
		key: "stripe-monitor",
		expectedVersion: 0,
		name: "Credits",
		type: "credits",
		amount: 990,
		currency: "USD",
		credits: 10,
		published: true,
	});
	const order = await auth.api.createBusinessOrder({
		headers,
		body: {
			productId: product.id,
			provider: "stripe",
			idempotencyKey: "stripe-checkout",
		},
	});
	orderId = order.id;
	await auth.api.checkoutBusinessOrder({ headers, body: { orderId } });
	function delivery(valid = true) {
		const timestamp = Math.floor(Date.now() / 1000);
		const secret = valid ? environment.STRIPE_WEBHOOK_SECRET : "whsec_wrong";
		const cryptoProvider = Stripe.createNodeCryptoProvider();
		const payload = JSON.stringify({
			id: "evt_monitor",
			object: "event",
			type: "checkout.session.completed",
			data: { object: checkout() },
		});
		return new Request(`${environment.BETTER_AUTH_URL}/api/payments/webhook`, {
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
	assert.equal((await POST(delivery(false))).status, 503);
	assert.equal(await adapter.count({ model: "businessMonitorEvent" }), 0);
	const [response] = await Promise.all([
		POST(delivery()),
		auth.api.completeBusinessOrder({ headers, body: { orderId } }),
	]);
	assert.equal(response.status, 200);
	assert.equal((await POST(delivery())).status, 200);
	assert.equal(await adapter.count({ model: "businessMonitorEvent" }), 1);
	assert.equal(await adapter.count({ model: "creditEntry" }), 1);
	await auth.api.runMonitorDelivery();
	assert.equal(reported.length, 1);
	assert.equal(reported[0].event_type, "payment_confirmed");
	assert.equal(
		reported[0].occurred_at,
		new Date(paidSeconds * 1000).toISOString(),
	);
	assert.deepEqual(reported[0].identity, {
		user_id: user.id,
		order_id: orderId,
	});
	assert.deepEqual(reported[0].props, { amount: 990, currency: "USD" });
});
