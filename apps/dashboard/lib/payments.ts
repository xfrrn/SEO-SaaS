import type { BusinessPaymentProvider } from "@app/auth-sdk/business";
import {
	createPayPalBusinessProvider,
	createPayPalClient,
} from "@app/auth-sdk/paypal";
import { createStripeBusinessProvider } from "@app/auth-sdk/stripe";
import Stripe from "stripe";
import { readPaymentConfig } from "./payment-config.ts";

/** Reuse the SDK's channel adapters for checkout and signed provider notifications. */
export function createPayments(baseURL: string) {
	const config = readPaymentConfig();
	const providers: Record<string, BusinessPaymentProvider> = {};
	const returnURL = `${baseURL}/payment/return`;
	const cancelURL = `${baseURL}/payment/return?canceled=1`;
	if (config?.provider === "stripe") {
		const client = new Stripe(config.secretKey, {
			timeout: 15_000,
			maxNetworkRetries: 2,
		});
		providers.stripe = createStripeBusinessProvider({
			stripeClient: client,
			returnURL,
			cancelURL,
		});
		return {
			providers,
			async webhook(request: Request) {
				const signature = request.headers.get("stripe-signature");
				if (!signature) throw new Error("Missing payment signature");
				const event = await client.webhooks.constructEventAsync(
					await request.text(),
					signature,
					config.webhookSecret,
				);
				if (
					event.type !== "checkout.session.completed" &&
					event.type !== "checkout.session.async_payment_succeeded"
				)
					return null;
				const checkout = event.data.object;
				if (checkout.payment_status !== "paid") return null;
				const orderId = checkout.metadata?.businessOrderId;
				return orderId
					? { provider: "stripe", orderId, reference: checkout.id }
					: null;
			},
		};
	}
	if (config?.provider === "paypal") {
		const client = createPayPalClient({ ...config, orderExpiration: true });
		providers.paypal = createPayPalBusinessProvider({
			client,
			returnURL,
			cancelURL,
		});
		return {
			providers,
			async webhook(request: Request) {
				const event = await client.verifyWebhook({
					headers: request.headers,
					body: await request.text(),
				});
				let reference: unknown;
				if (event.event_type === "CHECKOUT.ORDER.APPROVED")
					reference = event.resource.id;
				else if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
					const data = event.resource.supplementary_data;
					if (data && typeof data === "object" && "related_ids" in data) {
						const ids = data.related_ids;
						if (ids && typeof ids === "object" && "order_id" in ids)
							reference = ids.order_id;
					}
				} else return null;
				if (typeof reference !== "string")
					throw new Error("Missing PayPal order reference");
				const order = await client.getOrder(reference);
				const orderId = order.purchase_units?.[0]?.custom_id;
				return orderId ? { provider: "paypal", orderId, reference } : null;
			},
		};
	}
	return { providers, webhook: undefined };
}
