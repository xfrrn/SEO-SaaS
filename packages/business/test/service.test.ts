import { createCreditsService, credits } from "@app/credits";
import { createProductService, subscription } from "@app/subscription";
import { admin } from "better-auth/plugins/admin";
import { getTestInstance } from "better-auth/test";
import { expect, it } from "vitest";
import { business, createBusinessService } from "../src";

it("keeps composite operation keys distinct and bounded for SQL unique columns", async () => {
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
	const providerName = "p".repeat(128);
	const service = createBusinessService(
		adapter,
		{ catalog: true },
		{
			providers: {
				[providerName]: {
					createCheckout: async () => ({
						providerOrderId: "o".repeat(128),
						url: "https://pay.example/checkout",
					}),
					verifyPayment: async ({ order }) => ({
						paymentId: "p".repeat(128),
						providerOrderId: order.providerOrderId!,
						amount: order.amount,
						currency: order.currency,
						paidAt: order.createdAt,
					}),
				},
			},
		},
	);
	const adjustment = {
		referenceId: user.id,
		action: "grant" as const,
		amount: 10,
		reason: "Support correction",
	};
	await service.adjustCredits("a:b", { ...adjustment, operationId: "c" });
	await service.adjustCredits("a", { ...adjustment, operationId: "b:c" });
	expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
		balance: 20,
	});
	expect(await adapter.count({ model: "adminAuditLog" })).toBe(2);
	const product = await createProductService(adapter).save({
		key: "credits",
		name: "Credits",
		type: "credits",
		amount: 100,
		currency: "USD",
		credits: 5,
		published: true,
		expectedVersion: 0,
	});
	const order = await service.createOrder(user.id, {
		productId: product.id,
		provider: providerName,
		idempotencyKey: "i".repeat(128),
	});
	await service.checkout(user.id, order.id);
	const paid = await service.confirmPayment(order.id, "verified");
	expect(paid.status).toBe("fulfilled");
	expect(paid.providerKey!.length).toBeLessThanOrEqual(255);
	const [event] = await adapter.findMany<{ eventKey: string }>({
		model: "businessPaymentEvent",
	});
	expect(event!.eventKey.length).toBeLessThanOrEqual(255);
	expect(await createCreditsService(adapter).balance(user.id)).toMatchObject({
		balance: 25,
	});
});
