import type { createAuthClient } from "@app/auth-sdk/react";
import type { Auth } from "@app/auth-sdk/server";
import { stripe } from "@app/auth-sdk/stripe";
import type { StripePlugin, Subscription } from "@app/auth-sdk/stripe";
import { stripeClient } from "@app/auth-sdk/stripe/client";
import { getTestInstance } from "better-auth/test";
import type Stripe from "stripe";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	createPrice,
	createSubscriptionEvent,
	createSubscriptionItem,
} from "../../stripe/test/_factories";
import {
	TEST_PRICES,
	TEST_WEBHOOK_SECRET,
	test,
} from "../../stripe/test/_fixtures";

describe("SDK optional Stripe integration", () => {
	it("only infers subscription methods when configured", () => {
		type EnabledClient = ReturnType<
			typeof createAuthClient<{
				plugins: [ReturnType<typeof stripeClient<{ subscription: true }>>];
			}>
		>;
		type DisabledClient = ReturnType<
			typeof createAuthClient<{
				plugins: [ReturnType<typeof stripeClient<{ subscription: false }>>];
			}>
		>;
		type DisabledAuth = Auth<{
			plugins: [
				StripePlugin<{
					stripeClient: Stripe;
					stripeWebhookSecret: string;
				}>,
			];
		}>;

		expectTypeOf<EnabledClient["subscription"]["upgrade"]>().toBeFunction();
		expectTypeOf<EnabledClient["subscription"]["list"]>().toBeFunction();
		expectTypeOf<EnabledClient["subscription"]["cancel"]>().toBeFunction();
		expectTypeOf<EnabledClient["subscription"]["restore"]>().toBeFunction();
		expectTypeOf<EnabledClient["subscription"]["billingPortal"]>().toBeFunction();
		expectTypeOf<"subscription">().not.toExtend<keyof DisabledClient>();
		expectTypeOf<DisabledAuth["api"]["stripeWebhook"]>().toBeFunction();
		expectTypeOf<"upgradeSubscription">().not.toExtend<
			keyof DisabledAuth["api"]
		>();
	});

	test("requires a session and lists only the current user's active subscriptions", async ({
		stripeOptions,
	}) => {
		const { auth, client, signInWithTestUser } = await getTestInstance(
			{ plugins: [stripe(stripeOptions)] },
			{ clientOptions: { plugins: [stripeClient({ subscription: true })] } },
		);
		expect((await client.subscription.list()).error?.status).toBe(401);
		expect(
			(await client.subscription.upgrade({ plan: "starter" })).error?.status,
		).toBe(401);
		const { user, headers } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		await adapter.create({
			model: "subscription",
			data: { referenceId: user.id, plan: "starter", status: "active" },
		});
		await adapter.create({
			model: "subscription",
			data: { referenceId: user.id, plan: "premium", status: "canceled" },
		});
		await adapter.create({
			model: "subscription",
			data: { referenceId: "another-user", plan: "premium", status: "active" },
		});
		const subscriptions = await client.subscription.list({
			fetchOptions: { headers, throw: true },
		});
		expect(subscriptions).toHaveLength(1);
		expect(subscriptions[0]).toMatchObject({
			referenceId: user.id,
			plan: "starter",
			status: "active",
		});
	});

	test("passes webhook verification through and synchronizes subscription status", async ({
		stripeOptions,
		stripeMock,
	}) => {
		const { auth, testUser } = await getTestInstance({
			plugins: [stripe(stripeOptions)],
			logger: { disabled: true },
		});
		const { adapter } = await auth.$context;
		const user = await adapter.findOne<{ id: string }>({
			model: "user",
			where: [{ field: "email", value: testUser.email }],
		});
		expect(user).not.toBeNull();
		const subscription = await adapter.create<Subscription>({
			model: "subscription",
			data: {
				referenceId: user!.id,
				stripeCustomerId: "cus_mock123",
				stripeSubscriptionId: "sub_sdk",
				plan: "starter",
				status: "incomplete",
			},
		});
		const event = createSubscriptionEvent("customer.subscription.updated", {
			id: "sub_sdk",
			customer: "cus_mock123",
			status: "active",
			items: {
				object: "list",
				data: [
					createSubscriptionItem({
						price: createPrice({ id: TEST_PRICES.starter }),
					}),
				],
				has_more: false,
				url: "/v1/subscription_items",
			},
		});
		const payload = JSON.stringify(event);
		const request = () =>
			new Request("http://localhost:3000/api/auth/stripe/webhook", {
				method: "POST",
				headers: { "stripe-signature": "sdk-signature" },
				body: payload,
			});

		stripeMock.webhooks.constructEventAsync.mockRejectedValueOnce(
			new Error("Invalid signature"),
		);
		expect((await auth.handler(request())).status).toBe(400);
		expect(
			await adapter.findOne<Subscription>({
				model: "subscription",
				where: [{ field: "id", value: subscription.id }],
			}),
		).toMatchObject({ status: "incomplete" });

		stripeMock.webhooks.constructEventAsync.mockResolvedValueOnce(event);
		expect((await auth.handler(request())).status).toBe(200);
		expect(stripeMock.webhooks.constructEventAsync).toHaveBeenLastCalledWith(
			payload,
			"sdk-signature",
			TEST_WEBHOOK_SECRET,
		);
		expect(
			await adapter.findOne<Subscription>({
				model: "subscription",
				where: [{ field: "id", value: subscription.id }],
			}),
		).toMatchObject({ status: "active", plan: "starter" });
	});
});
