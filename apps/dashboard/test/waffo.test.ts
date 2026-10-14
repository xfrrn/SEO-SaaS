import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCreditsService } from "@app/auth-sdk/credits";
import { createProductService } from "@app/auth-sdk/subscription";
import { getMigrations } from "better-auth/db/migration";
import { POST } from "../app/api/payments/webhook/route.ts";
import { closeAuth, getAuth } from "../lib/auth.ts";

test("Waffo signed notifications and browser completion fulfill a real checkout once", async (t) => {
	const database = fileURLToPath(
		new URL(`../.cache/waffo-${randomUUID()}.sqlite`, import.meta.url),
	);
	const keys = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const environment = {
		NODE_ENV: "test",
		DATABASE_URL: "",
		DASHBOARD_SQLITE_PATH: database,
		BETTER_AUTH_URL: "https://app.example.test",
		BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
		PAYMENT_PROVIDER: "waffo",
		WAFFO_MERCHANT_ID: "MER_1234567890123456789012",
		WAFFO_PRIVATE_KEY: keys.privateKey,
		WAFFO_STORE_ID: "STO_test",
		WAFFO_PRODUCT_ID: "PROD_1234567890123456789012",
		WAFFO_ENVIRONMENT: "test",
		WAFFO_WEBHOOK_TEST_PUBLIC_KEY: keys.publicKey,
		APP_MONITOR_ENABLED: "false",
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
	let orderId = "";
	let paid = false;
	let failQuery = false;
	let checkouts = 0;
	let queries = 0;
	const paidAt = new Date().toISOString();
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			assert.equal(url.origin, "https://api.waffo.ai");
			const body = JSON.parse(String(init?.body));
			if (url.pathname.endsWith("create-session")) {
				checkouts++;
				assert.equal(
					new Headers(init?.headers).get("x-idempotency-key"),
					orderId,
				);
				assert.equal(body.orderMerchantExternalId, orderId);
				assert.deepEqual(body.priceSnapshot, {
					amount: "9.99",
					taxCategory: "saas",
				});
				return Response.json({
					data: {
						sessionId: "cs_waffo",
						checkoutUrl: "https://checkout.waffo.ai/test/checkout/cs_waffo",
						expiresAt: new Date(Date.now() + 3600000).toISOString(),
					},
				});
			}
			assert.equal(url.pathname, "/v1/graphql");
			if (body.query.includes("onetimeProduct(id:"))
				return Response.json({
					data: {
						onetimeProduct: {
							id: "PROD_1234567890123456789012",
							status: "active",
							store: { id: "STO_test" },
						},
					},
				});
			queries++;
			assert.equal(body.variables.ref, orderId);
			if (failQuery)
				return Response.json(
					{ errors: [{ message: "temporary failure" }] },
					{ status: 503 },
				);
			return Response.json({
				data: {
					payments: paid
						? [
								{
									id: "PAY_test",
									orderId: "ORD_test",
									orderMerchantExternalId: orderId,
									status: "succeeded",
									createdAt: paidAt,
									snapshotAmountDetails: {
										currency: "USD",
										subtotal: "9.99",
										taxAmount: "1.00",
										total: "10.99",
									},
									onetimeOrder: {
										id: "ORD_test",
										status: "completed",
										testMode: true,
										store: { id: "STO_test" },
										onetimeProduct: { id: "PROD_1234567890123456789012" },
									},
								},
							]
						: [],
				},
			});
		},
	);
	function delivery(corrupt = false) {
		const body = JSON.stringify({
			id: "delivery-1",
			timestamp: paidAt,
			mode: "test",
			storeId: "STO_test",
			eventType: "order.completed",
			data: { orderMerchantExternalId: orderId },
		});
		const time = Date.now();
		const signature = sign(
			"RSA-SHA256",
			Buffer.from(`${time}.${body}`),
			keys.privateKey,
		).toString("base64");
		return new Request(`${environment.BETTER_AUTH_URL}/api/payments/webhook`, {
			method: "POST",
			body: body + (corrupt ? " " : ""),
			headers: { "x-waffo-signature": `t=${time},v1=${signature}` },
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
				email: "waffo@example.test",
				password,
				role: "user",
			},
		});
		const signed = await auth.api.signInEmail({
			body: { email: user.email, password },
			returnHeaders: true,
		});
		const headers = new Headers({ cookie: signed.headers.get("set-cookie")! });
		assert.deepEqual(await auth.api.listBusinessProviders({ headers }), {
			providers: ["waffo"],
		});
		const product = await createProductService(adapter).save({
			key: "waffo-credits",
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
				provider: "waffo",
				idempotencyKey: "test-waffo",
			},
		});
		orderId = order.id;
		// A delivery arriving before checkout persistence must retry, not disappear.
		assert.equal((await POST(delivery())).status, 503);
		const checkout = await auth.api.checkoutBusinessOrder({
			headers,
			body: { orderId },
		});
		assert.equal(checkout.providerOrderId, "cs_waffo");
		await auth.api.checkoutBusinessOrder({ headers, body: { orderId } });
		assert.equal(checkouts, 1);
		const credits = createCreditsService(adapter);
		await assert.rejects(
			auth.api.completeBusinessOrder({ headers, body: { orderId } }),
		);
		assert.equal((await credits.balance(user.id)).balance, 0);
		const before = queries;
		assert.equal((await POST(delivery(true))).status, 503);
		assert.equal(queries, before);
		paid = true;
		failQuery = true;
		assert.equal((await POST(delivery())).status, 503);
		assert.equal((await credits.balance(user.id)).balance, 0);
		failQuery = false;
		assert.equal((await POST(delivery())).status, 200);
		assert.equal((await POST(delivery())).status, 200);
		await auth.api.completeBusinessOrder({ headers, body: { orderId } });
		assert.equal((await credits.balance(user.id)).balance, 80);
		assert.equal(await adapter.count({ model: "creditEntry" }), 1);
		assert.equal(await adapter.count({ model: "businessPaymentEvent" }), 1);
		assert.equal(checkouts, 1);
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
