import type { DatabaseSync } from "node:sqlite";
import { credits } from "@app/credits";
import { createProductService, subscription } from "@app/subscription";
import type { BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { getTestInstance } from "better-auth/test";
import { expect, it, vi } from "vitest";
import { business, createBusinessService } from "../src";
import { businessClient } from "../src/client";
import type { MonitorEvent, MonitorOptions } from "../src/monitor";

const origin = "http://localhost:3000";
const touch = {
	schema_version: 1,
	site_id: "test-site",
	attribution: {
		first_touch: {
			kind: "campaign",
			occurred_at: "2026-01-01T00:00:00.000Z",
			landing_page: `${origin}/`,
			utm: { utm_source: "newsletter" },
		},
	},
};
const contextHeaders = (value: unknown = touch) => ({
	"x-monitor-context": btoa(JSON.stringify(value))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", ""),
});

async function setup(enabled = true) {
	const send = vi.fn(async (_event: MonitorEvent) => ({
		accepted: 1,
		duplicates: 0,
	}));
	const monitor: MonitorOptions = {
		siteId: "test-site",
		environment: "development",
		endpoint: "https://collector.example/v1/server-events",
		parseContext(value) {
			if (
				value &&
				typeof value === "object" &&
				"site_id" in value &&
				value.site_id === "test-site"
			)
				return structuredClone(value as Record<string, unknown>);
		},
		send,
	};
	const instance = await getTestInstance(
		{
			emailAndPassword: { enabled: true, requireEmailVerification: true },
			socialProviders: { google: { clientId: "test", clientSecret: "test" } },
			plugins: [
				admin({ auditLog: true }),
				subscription({ catalog: true }),
				credits(),
				business({
					monitor: enabled ? monitor : undefined,
					providers: {
						test: {
							async createCheckout(order) {
								return {
									providerOrderId: `remote-${order.id}`,
									url: "https://pay.example/checkout",
								};
							},
							async verifyPayment({ order }) {
								return {
									paymentId: `paid-${order.id}`,
									providerOrderId: `remote-${order.id}`,
									amount: order.amount,
									currency: order.currency,
									paidAt: order.createdAt,
								};
							},
						},
					},
				}),
			],
		},
		{ clientOptions: { plugins: [businessClient()] } },
	);
	const { adapter, options: authOptions } = await instance.auth.$context;
	await adapter.updateMany({
		model: "user",
		where: [],
		update: { emailVerified: true },
	});
	const { user, headers } = await instance.signInWithTestUser();
	await adapter.update({
		model: "user",
		where: [{ field: "id", value: user.id }],
		update: { role: "admin" },
	});
	// The fixture account is not an acquisition event in these assertions.
	await adapter.updateMany({
		model: "user",
		where: [],
		update: { monitorSignupPending: false },
	});
	const product = await createProductService(adapter).save({
		key: "monitor-credits",
		name: "Credits",
		type: "credits",
		amount: 990,
		currency: "USD",
		credits: 10,
		expectedVersion: 0,
		published: true,
	});
	async function buy(
		key: string = crypto.randomUUID(),
		attribution: unknown = touch,
	) {
		const requestHeaders = new Headers(headers);
		for (const [name, value] of Object.entries(contextHeaders(attribution)))
			requestHeaders.set(name, value);
		const order = await instance.auth.api.createBusinessOrder({
			headers: requestHeaders,
			body: { productId: product.id, provider: "test", idempotencyKey: key },
		});
		return instance.auth.api.checkoutBusinessOrder({
			headers,
			body: { orderId: order.id },
		});
	}
	return {
		...instance,
		adapter,
		user,
		headers,
		buy,
		send,
		monitor,
		product,
		sql: (authOptions as BetterAuthOptions).database as DatabaseSync,
	};
}

it("persists real registrations before dispatch, ignores synthetic duplicates and hides internal fields", async () => {
	const { auth, adapter, send, headers } = await setup();
	const body = {
		name: "Acquired",
		email: "acquired@example.com",
		password: "secret-password-123",
	};
	const registered = await auth.api.signUpEmail({
		body,
		headers: contextHeaders(),
	});
	expect(JSON.stringify(registered)).not.toMatch(
		/monitorSignup|monitorSiteId|newsletter/,
	);
	await auth.api.signUpEmail({
		body,
		headers: contextHeaders({ ...touch, site_id: "forged" }),
	});
	expect(send).not.toHaveBeenCalled();
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]![0]).toMatchObject({
		type: "signup_confirmed",
		record: { userId: registered.user.id, attribution: touch, method: "email" },
	});
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(await adapter.count({ model: "businessMonitorEvent" })).toBe(1);
	const result = await auth.api.listMonitorEvents({ headers });
	expect(result.events[0]!.status).toBe("sent");
	expect(result.events[0]!.payload.record.occurredAt).toEqual(
		expect.any(String),
	);
	await auth.api.createUser({
		body: {
			name: "Manual",
			email: "manual@example.com",
			password: "secret-password-123",
			role: "user",
		},
	});
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
});

it("keeps checkout attribution immutable and unexposed, queues a verified payment exactly once", async () => {
	const { auth, adapter, headers, buy, send, product, user } = await setup();
	const order = await buy("same-purchase");
	expect(JSON.stringify(order)).not.toMatch(/monitorContext|newsletter/);
	await auth.api.createBusinessOrder({
		headers,
		body: {
			productId: product.id,
			provider: "test",
			idempotencyKey: "same-purchase",
		},
	});
	await Promise.all([
		auth.api.completeBusinessOrder({ headers, body: { orderId: order.id } }),
		auth.api.confirmBusinessPayment({
			body: { orderId: order.id, reference: order.providerOrderId! },
		}),
	]);
	expect(await adapter.count({ model: "businessMonitorEvent" })).toBe(1);
	expect(send).not.toHaveBeenCalled();
	await auth.api.runMonitorDelivery();
	expect(send.mock.calls[0]![0]).toMatchObject({
		type: "payment_confirmed",
		record: {
			userId: user.id,
			orderId: order.id,
			amount: 990,
			currency: "USD",
			attribution: touch,
		},
	});
	expect(
		(
			await auth.api.getMonitorAttribution({
				headers,
				query: { orderId: order.id },
			})
		).attribution,
	).toEqual(touch);
	expect(
		JSON.stringify(await auth.api.listOwnBusinessOrders({ headers })),
	).not.toMatch(/monitorContext|newsletter/);
	expect(await adapter.count({ model: "creditEntry" })).toBe(1);
});

it("does not inherit a user's old acquisition when an order supplies no valid clues", async () => {
	const { auth, headers, buy, send } = await setup();
	const order = await buy(undefined, { ...touch, site_id: "another-site" });
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: order.id },
	});
	await auth.api.runMonitorDelivery();
	expect(send.mock.calls[0]![0].record.attribution).toBeUndefined();
});

it("recovers unacknowledged sends with the same UUID and enforces retry permissions and audit", async () => {
	const { auth, adapter, headers, buy, send } = await setup();
	const order = await buy();
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: order.id },
	});
	send.mockRejectedValueOnce(
		Object.assign(new Error("private response must not escape"), {
			code: "collector_network_error",
			retryable: true,
		}),
	);
	await auth.api.runMonitorDelivery();
	const first = (await auth.api.listMonitorEvents({ headers })).events[0]!;
	expect(first).toMatchObject({
		status: "pending",
		attempts: 1,
		lastError: "collector_network_error",
	});
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	await adapter.update({
		model: "businessMonitorEvent",
		where: [{ field: "eventId", value: first.eventId }],
		update: { nextAttemptAt: new Date(0) },
	});
	send.mockResolvedValueOnce({ accepted: 0, duplicates: 1 });
	await Promise.all([
		auth.api.runMonitorDelivery(),
		auth.api.runMonitorDelivery(),
	]);
	expect(send).toHaveBeenCalledTimes(2);
	expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
	await expect(
		auth.api.retryMonitorEvent({
			headers,
			body: {
				eventId: first.eventId,
				operationId: "retry-sent",
				reason: "Check delivery",
			},
		}),
	).rejects.toThrow();

	const another = await buy();
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: another.id },
	});
	send.mockRejectedValueOnce(
		Object.assign(new Error("token must not escape"), {
			code: "collector_http_error",
			status: 403,
			retryable: false,
		}),
	);
	await auth.api.runMonitorDelivery();
	const failed = (
		await auth.api.listMonitorEvents({ headers, query: { status: "failed" } })
	).events[0]!;
	expect(failed.lastError).toBe("collector_http_error");
	await expect(
		auth.api.listMonitorEvents({ headers: new Headers() }),
	).rejects.toThrow();
	const retry = {
		eventId: failed.eventId,
		operationId: "retry-failed",
		reason: "Credential corrected",
	};
	await auth.api.retryMonitorEvent({ headers, body: retry });
	await auth.api.retryMonitorEvent({ headers, body: retry });
	await auth.api.runMonitorDelivery();
	expect(
		(
			await auth.api.listMonitorEvents({
				headers,
				query: { orderId: another.id },
			})
		).events[0]!.status,
	).toBe("sent");
	expect(
		await adapter.count({
			model: "adminAuditLog",
			where: [{ field: "action", value: "monitor.retry" }],
		}),
	).toBe(1);
});

it("reclaims abandoned leases, expires old deliveries, and leaves disabled monitoring paused", async () => {
	const { auth, adapter, headers, buy, send } = await setup();
	const order = await buy();
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: order.id },
	});
	const queued = (await auth.api.listMonitorEvents({ headers })).events[0]!;
	await adapter.update({
		model: "businessMonitorEvent",
		where: [{ field: "eventId", value: queued.eventId }],
		update: {
			status: "processing",
			leaseToken: "dead-process",
			leaseExpiresAt: new Date(0),
		},
	});
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	const next = await buy();
	await auth.api.completeBusinessOrder({ headers, body: { orderId: next.id } });
	await adapter.updateMany({
		model: "businessMonitorEvent",
		where: [{ field: "status", value: "pending" }],
		update: { firstAttemptAt: new Date(Date.now() - 8 * 86_400_000) },
	});
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(
		(await auth.api.listMonitorEvents({ headers, query: { orderId: next.id } }))
			.events[0]!.status,
	).toBe("expired");
	const disabled = await setup(false);
	const pending = await disabled.buy();
	await disabled.auth.api.completeBusinessOrder({
		headers: disabled.headers,
		body: { orderId: pending.id },
	});
	await disabled.auth.api.runMonitorDelivery();
	expect(disabled.send).not.toHaveBeenCalled();
	expect(
		await disabled.auth.api.getMonitorStatus({ headers: disabled.headers }),
	).toMatchObject({ enabled: false });
});

it("rolls back signup and registration queue failures, then resumes committed pending registrations", async () => {
	const { auth, adapter, sql, send, headers, client } = await setup();
	const body = {
		name: "Rollback",
		email: "rollback@example.com",
		password: "secret-password-123",
	};
	sql.exec(
		"CREATE TRIGGER reject_account BEFORE INSERT ON account BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
	);
	await expect(auth.api.signUpEmail({ body })).rejects.toThrow();
	expect(
		await adapter.count({
			model: "user",
			where: [{ field: "email", value: body.email }],
		}),
	).toBe(0);
	sql.exec("DROP TRIGGER reject_account");
	const created = await auth.api.signUpEmail({
		body,
		headers: contextHeaders(),
	});
	sql.exec(
		"CREATE TRIGGER reject_monitor BEFORE INSERT ON businessMonitorEvent BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END",
	);
	await expect(auth.api.runMonitorDelivery()).rejects.toThrow();
	expect(
		await adapter.findOne({
			model: "user",
			where: [{ field: "id", value: created.user.id }],
		}),
	).toMatchObject({ monitorSignupPending: true });
	expect(send).not.toHaveBeenCalled();
	sql.exec("DROP TRIGGER reject_monitor");
	await auth.api.runMonitorDelivery();
	await adapter.update({
		model: "user",
		where: [{ field: "id", value: created.user.id }],
		update: { emailVerified: true },
	});
	const signed = await auth.api.signInEmail({ body });
	expect(JSON.stringify(signed)).not.toMatch(/monitorSignup|newsletter/);
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	const response = await client.business.admin.monitor.events({
		fetchOptions: { headers },
	});
	expect(response.error).toBeNull();
	expect(typeof response.data!.events[0]!.payload.record.occurredAt).toBe(
		"string",
	);
	expect(response.data!.events[0]!.payload.record.attribution).toEqual(touch);
});

it("requires a local payment outbox commit and still reports paid orders when fulfillment fails", async () => {
	const { auth, adapter, sql, buy, send, headers } = await setup();
	const order = await buy();
	const confirm = () =>
		auth.api.completeBusinessOrder({ headers, body: { orderId: order.id } });
	sql.exec(
		"CREATE TRIGGER reject_monitor BEFORE INSERT ON businessMonitorEvent BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END",
	);
	await expect(confirm()).rejects.toThrow();
	expect(await adapter.count({ model: "businessPaymentEvent" })).toBe(0);
	expect(
		await adapter.findOne({
			model: "businessOrder",
			where: [{ field: "id", value: order.id }],
		}),
	).toMatchObject({ status: "pending", paymentId: null });
	sql.exec(
		"DROP TRIGGER reject_monitor; CREATE TRIGGER reject_credits BEFORE INSERT ON creditEntry BEGIN SELECT RAISE(ABORT, 'test fulfillment failure'); END",
	);
	await expect(confirm()).rejects.toThrow();
	expect(
		await adapter.findOne({
			model: "businessOrder",
			where: [{ field: "id", value: order.id }],
		}),
	).toMatchObject({ status: "paid", fulfilledAt: null });
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]![0].record.occurredAt).toBe(
		order.createdAt.toISOString(),
	);
	sql.exec("DROP TRIGGER reject_credits");
	await auth.api.retryBusinessFulfillment({
		headers,
		body: { orderId: order.id },
	});
	await confirm();
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(await adapter.count({ model: "creditEntry" })).toBe(1);
});

it("recovers remote acceptance after a local acknowledgement failure without changing the event", async () => {
	const { auth, sql, buy, headers, adapter, send } = await setup();
	const order = await buy();
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: order.id },
	});
	sql.exec(
		"CREATE TRIGGER reject_ack BEFORE UPDATE ON businessMonitorEvent WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'test ack failure'); END",
	);
	await expect(auth.api.runMonitorDelivery()).rejects.toThrow(
		"Monitor delivery persistence failed",
	);
	const [lost] = (await auth.api.listMonitorEvents({ headers })).events;
	expect(lost).toMatchObject({ status: "processing", attempts: 1 });
	sql.exec("DROP TRIGGER reject_ack");
	await adapter.updateMany({
		model: "businessMonitorEvent",
		where: [],
		update: { leaseExpiresAt: new Date(0) },
	});
	send.mockResolvedValueOnce({ accepted: 0, duplicates: 1 });
	await auth.api.runMonitorDelivery();
	expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
	expect(
		(await auth.api.listMonitorEvents({ headers })).events[0],
	).toMatchObject({ status: "sent", attempts: 2 });
});

it("bounds automatic retries and respects Retry-After, malformed receipts and site scoping", async () => {
	const { auth, adapter, headers, buy, send, user } = await setup();
	const order = await buy();
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: order.id },
	});
	send.mockRejectedValue(
		Object.assign(new Error("private response"), {
			code: "collector_http_error",
			status: 429,
			retryAfterMs: 7_200_000,
		}),
	);
	for (let attempt = 0; attempt < 8; attempt++) {
		await auth.api.runMonitorDelivery();
		const event = (await auth.api.listMonitorEvents({ headers })).events[0]!;
		if (attempt < 7) {
			expect(event.nextAttemptAt!.getTime()).toBeGreaterThan(
				Date.now() + 7_100_000,
			);
			await adapter.updateMany({
				model: "businessMonitorEvent",
				where: [],
				update: { nextAttemptAt: new Date(0) },
			});
		}
	}
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(8);
	const event = (await auth.api.listMonitorEvents({ headers })).events[0]!;
	expect(event).toMatchObject({ status: "failed", attempts: 8 });
	await auth.api.retryMonitorEvent({
		headers,
		body: {
			eventId: event.eventId,
			operationId: "malformed",
			reason: "Fix receiver",
		},
	});
	send.mockResolvedValueOnce({ accepted: 0, duplicates: 0 });
	await auth.api.runMonitorDelivery();
	expect(
		(await auth.api.listMonitorEvents({ headers })).events[0],
	).toMatchObject({
		status: "failed",
		attempts: 9,
		lastError: "collector_invalid_receipt",
	});
	await adapter.updateMany({
		model: "businessMonitorEvent",
		where: [],
		update: { siteId: "another-site" },
	});
	expect((await auth.api.listMonitorEvents({ headers })).total).toBe(0);
	await expect(
		auth.api.retryMonitorEvent({
			headers,
			body: {
				eventId: event.eventId,
				operationId: "other-site",
				reason: "Try",
			},
		}),
	).rejects.toThrow();
	await adapter.update({
		model: "user",
		where: [{ field: "id", value: user.id }],
		update: { role: "user" },
	});
	await expect(auth.api.getMonitorStatus({ headers })).rejects.toMatchObject({
		status: "FORBIDDEN",
	});
	await expect(
		auth.api.retryMonitorEvent({
			headers,
			body: { eventId: event.eventId, operationId: "denied", reason: "Try" },
		}),
	).rejects.toMatchObject({ status: "FORBIDDEN" });
	const http = await auth.handler(
		new Request(`${origin}/api/auth/run-monitor-delivery`, { method: "POST" }),
	);
	expect(http.status).toBe(404);
});

it("carries OAuth initiation clues in protected state and counts only new OAuth accounts", async () => {
	const { auth, client, cookieSetter, adapter, send } = await setup();
	const ctx = await auth.$context;
	if (!Array.isArray(ctx.socialProviders))
		throw new Error("Fixture needs static providers");
	const provider = ctx.socialProviders.find((item) => item.id === "google")!;
	vi.spyOn(provider, "validateAuthorizationCode").mockResolvedValue({
		accessToken: "test-access",
	});
	vi.spyOn(provider, "getUserInfo").mockResolvedValue({
		user: {
			name: "Social user",
			email: "oauth@example.com",
			emailVerified: true,
		},
		data: { sub: "google-new" },
	});
	async function login() {
		const cookies = new Headers();
		const started = await client.signIn.social({
			provider: "google",
			callbackURL: "/",
			additionalData: {
				serverContext: { businessMonitor: { siteId: "forged" } },
			},
			fetchOptions: {
				headers: contextHeaders(),
				onSuccess: cookieSetter(cookies),
			},
		});
		expect(started.error).toBeNull();
		const state = new URL(started.data!.url!).searchParams.get("state")!;
		await client.$fetch("/callback/google", {
			method: "GET",
			headers: cookies,
			query: { state, code: "test" },
		});
	}
	await login();
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0]![0]).toMatchObject({
		type: "signup_confirmed",
		record: { method: "oauth", attribution: touch },
	});
	await login();
	await auth.api.runMonitorDelivery();
	expect(send).toHaveBeenCalledTimes(1);
	expect(
		await adapter.count({
			model: "user",
			where: [{ field: "email", value: "oauth@example.com" }],
		}),
	).toBe(1);
});

it("uses original order clues for a verified renewal and preserves disabled records", async () => {
	const { auth, adapter, headers, buy, monitor, user } = await setup();
	const order = await buy();
	await auth.api.completeBusinessOrder({
		headers,
		body: { orderId: order.id },
	});
	const renewedAt = new Date();
	const service = createBusinessService(
		adapter,
		{ catalog: true },
		{
			monitor,
			providers: {
				test: {
					createCheckout: async () => {
						throw new Error("Already checked out");
					},
					verifyPayment: async () => ({
						paymentId: "renewal-payment",
						providerOrderId: order.providerOrderId!,
						amount: order.amount,
						currency: order.currency,
						paidAt: renewedAt,
						periodStart: renewedAt,
						periodEnd: new Date(renewedAt.getTime() + 86_400_000),
					}),
				},
			},
		},
	);
	const renewal = await service.confirmRenewal(order.id, "renewal-reference");
	await service.confirmRenewal(order.id, "renewal-reference");
	expect(
		(
			await auth.api.getMonitorAttribution({
				headers,
				query: { orderId: renewal.id },
			})
		).attribution,
	).toEqual(touch);
	expect((await auth.api.listMonitorEvents({ headers })).total).toBe(2);
	expect(JSON.stringify(renewal)).not.toContain("monitorContext");
	const paused = createBusinessService(adapter, { catalog: true }, {});
	expect(
		(await paused.listOrders({ referenceId: user.id })).orders.length,
	).toBe(2);
});
