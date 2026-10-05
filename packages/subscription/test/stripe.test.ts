import { getTestInstance } from "better-auth/test";
import { describe, expect } from "vitest";
import { stripe } from "../../stripe/src";
import type { Subscription as StripeSubscription } from "../../stripe/src/types";
import {
	createCheckoutSessionCompletedEvent,
	createPrice,
	createSubscription,
	createSubscriptionEvent,
	createSubscriptionItem,
} from "../../stripe/test/_factories";
import { TEST_PRICES, test } from "../../stripe/test/_fixtures";
import { subscription } from "../src";

const day = 86_400_000;
const plans = [
	{ name: "starter", limits: { projects: 1 } },
	{ name: "premium", limits: { projects: 10 } },
];
const payment = (referenceId: string, providerSubscriptionId = "member-1") => ({
	provider: "paypal",
	providerSubscriptionId,
	referenceId,
	plan: "starter",
	status: "active" as const,
	revision: 0,
	periodStart: new Date(Date.now() - day),
	periodEnd: new Date(Date.now() + day),
});

describe("shared subscriptions with Stripe", () => {
	for (const stripeFirst of [true, false]) {
		test(`shares the table in either plugin order (stripe first: ${stripeFirst}) without leaking channels`, async ({
			stripeOptions,
		}) => {
			const stripePlugin = stripe(stripeOptions);
			expect(stripePlugin.schema.subscription.fields).not.toHaveProperty(
				"provider",
			);
			const common = subscription({ plans });
			const { auth, signInWithTestUser } = await getTestInstance({
				plugins: stripeFirst ? [stripePlugin, common] : [common, stripePlugin],
			});
			const { user, headers } = await signInWithTestUser();
			await auth.api.syncSubscription({ body: payment(user.id) });
			const { adapter, tables } = await auth.$context;
			expect(tables.subscription?.fields).toHaveProperty("provider");
			expect(tables.subscription?.fields).toHaveProperty(
				"stripeSubscriptionId",
			);
			// Legacy Stripe rows remain usable without a backfilled provider value.
			await adapter.create({
				model: "subscription",
				data: {
					referenceId: user.id,
					plan: "starter",
					status: "active",
					stripeCustomerId: "cus_mock123",
					stripeSubscriptionId: "sub_legacy",
					periodStart: new Date(Date.now() - day),
					periodEnd: new Date(Date.now() + day),
				},
			});
			const onlyStripe = await auth.api.listActiveSubscriptions({ headers });
			expect(onlyStripe).toHaveLength(1);
			expect(onlyStripe[0]).toMatchObject({
				stripeSubscriptionId: "sub_legacy",
			});
			expect(
				await auth.api.listCustomerSubscriptions({ headers }),
			).toHaveLength(2);
		});
	}

	test("finds Stripe rows after more than one page of other-provider records", async ({
		stripeOptions,
	}) => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans }), stripe(stripeOptions)],
		});
		const { user, headers } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		for (let index = 0; index < 105; index++) {
			await adapter.create({
				model: "subscription",
				data: payment(user.id, `member-${index}`),
			});
		}
		await adapter.create({
			model: "subscription",
			data: {
				referenceId: user.id,
				provider: "stripe",
				plan: "starter",
				status: "active",
				stripeSubscriptionId: "sub_last",
			},
		});
		await adapter.create({
			model: "subscription",
			data: {
				referenceId: "other-user",
				provider: "stripe",
				plan: "starter",
				status: "active",
				stripeSubscriptionId: "sub_other",
			},
		});
		expect(await auth.api.listActiveSubscriptions({ headers })).toMatchObject([
			{ stripeSubscriptionId: "sub_last" },
		]);
		expect(await auth.api.listActiveSubscriptions({ headers })).toHaveLength(1);
	});

	test("creates a Stripe checkout without reusing a PayPal incomplete subscription", async ({
		stripeOptions,
		stripeMock,
	}) => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans }), stripe(stripeOptions)],
		});
		const { user, headers } = await signInWithTestUser();
		const paypal = await auth.api.syncSubscription({
			body: { ...payment(user.id), plan: "premium", status: "incomplete" },
		});
		await auth.api.upgradeSubscription({
			headers,
			body: { plan: "starter", successUrl: "/success", cancelUrl: "/cancel" },
		});
		expect(stripeMock.checkout.sessions.create).toHaveBeenCalledOnce();
		const { adapter } = await auth.$context;
		expect(
			await adapter.findOne({
				model: "subscription",
				where: [{ field: "id", value: paypal.subscription.id }],
			}),
		).toMatchObject({
			provider: "paypal",
			plan: "premium",
			status: "incomplete",
		});
		expect(await adapter.count({ model: "subscription" })).toBe(2);
		expect(
			await adapter.findOne({
				model: "subscription",
				where: [{ field: "provider", value: "stripe" }],
			}),
		).toMatchObject({ providerCustomerId: "cus_mock123", plan: "starter" });
	});

	test("cancels and restores only the Stripe subscription for a mixed-channel customer", async ({
		stripeOptions,
		stripeMock,
	}) => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans }), stripe(stripeOptions)],
		});
		const { user, headers } = await signInWithTestUser();
		const paypal = await auth.api.syncSubscription({
			body: { ...payment(user.id), cancelAtPeriodEnd: true },
		});
		const { adapter } = await auth.$context;
		await adapter.create({
			model: "subscription",
			data: {
				referenceId: user.id,
				plan: "starter",
				status: "active",
				provider: "stripe",
				stripeCustomerId: "cus_mock123",
				stripeSubscriptionId: "sub_stripe",
				cancelAtPeriodEnd: true,
			},
		});
		stripeMock.subscriptions.retrieve.mockResolvedValue(
			createSubscription({
				id: "sub_stripe",
				customer: "cus_mock123",
				cancel_at_period_end: true,
			}),
		);
		stripeMock.subscriptions.update.mockResolvedValue(
			createSubscription({ id: "sub_stripe" }),
		);
		await auth.api.cancelSubscription({
			headers,
			body: { returnUrl: "/account" },
		});
		expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				flow_data: {
					type: "subscription_cancel",
					subscription_cancel: { subscription: "sub_stripe" },
				},
			}),
		);
		await auth.api.restoreSubscription({ headers, body: {} });
		expect(stripeMock.subscriptions.update).toHaveBeenCalledWith("sub_stripe", {
			cancel_at_period_end: false,
		});
		expect(
			await adapter.findOne({
				model: "subscription",
				where: [{ field: "id", value: paypal.subscription.id }],
			}),
		).toMatchObject({
			provider: "paypal",
			cancelAtPeriodEnd: true,
			revision: 0,
		});
	});

	test("shares verified Stripe webhook state and refuses metadata pointing at another channel", async ({
		stripeOptions,
		stripeMock,
	}) => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans }), stripe(stripeOptions)],
			logger: { disabled: true },
		});
		const { user, headers } = await signInWithTestUser();
		const paypal = await auth.api.syncSubscription({ body: payment(user.id) });
		const { adapter } = await auth.$context;
		const local = await adapter.create<StripeSubscription>({
			model: "subscription",
			data: {
				referenceId: user.id,
				plan: "starter",
				status: "incomplete",
				stripeCustomerId: "cus_mock123",
				stripeSubscriptionId: "sub_webhook",
			},
		});
		const item = createSubscriptionItem({
			price: createPrice({ id: TEST_PRICES.starter }),
		});
		const native = createSubscription({
			id: "sub_webhook",
			customer: "cus_mock123",
			status: "active",
			items: { object: "list", data: [item], has_more: false, url: "/items" },
		});
		const send = async (event: ReturnType<typeof createSubscriptionEvent>) => {
			stripeMock.webhooks.constructEventAsync.mockResolvedValueOnce(event);
			const response = await auth.handler(
				new Request("http://localhost:3000/api/auth/stripe/webhook", {
					method: "POST",
					headers: { "stripe-signature": "test" },
					body: JSON.stringify(event),
				}),
			);
			expect(response.status).toBe(200);
		};
		await send(
			createSubscriptionEvent("customer.subscription.updated", native),
		);
		expect(
			await adapter.findOne({
				model: "subscription",
				where: [{ field: "id", value: local.id }],
			}),
		).toMatchObject({
			provider: "stripe",
			providerSubscriptionId: "sub_webhook",
			providerCustomerId: "cus_mock123",
			syncKey: JSON.stringify(["stripe", "sub_webhook"]),
			status: "active",
		});
		expect(await auth.api.listCustomerSubscriptions({ headers })).toHaveLength(
			2,
		);
		stripeMock.subscriptions.retrieve.mockResolvedValue(native);
		await send(
			createCheckoutSessionCompletedEvent({
				subscription: native.id,
				client_reference_id: user.id,
				metadata: {
					subscriptionId: paypal.subscription.id,
					referenceId: user.id,
				},
			}),
		);
		await send(
			createSubscriptionEvent("customer.subscription.updated", {
				...native,
				status: "canceled",
				metadata: { subscriptionId: paypal.subscription.id },
			}),
		);
		expect(
			await adapter.findOne({
				model: "subscription",
				where: [{ field: "id", value: paypal.subscription.id }],
			}),
		).toMatchObject({ provider: "paypal", status: "active", revision: 0 });
		expect(
			await adapter.findOne({
				model: "subscription",
				where: [{ field: "id", value: local.id }],
			}),
		).toMatchObject({ status: "active" });
	});

	test("rejects conflicting physical table mappings at initialization", async ({
		stripeOptions,
	}) => {
		await expect(
			getTestInstance({
				plugins: [
					stripe({
						...stripeOptions,
						schema: { subscription: { modelName: "stripe_only" } },
					}),
					subscription({ plans }),
				],
				logger: { disabled: true },
			}),
		).rejects.toThrow(/mapping conflicts/);
	});
});
