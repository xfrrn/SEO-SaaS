import type { BusinessPaymentProvider } from "@app/business";
import { appendQueryParams } from "@better-auth/core/utils/url";
import type Stripe from "stripe";

/** Existing Stripe client and trusted application-owned checkout redirects. */
export interface StripeBusinessProviderOptions {
	stripeClient: Stripe;
	returnURL: string;
	cancelURL: string;
}

function validateRedirect(value: string) {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			)) ||
		url.username ||
		url.password ||
		url.searchParams.has("orderId") ||
		url.searchParams.has("reference")
	) {
		throw new Error(
			"Stripe checkout redirects must be trusted HTTPS URLs without orderId/reference parameters (HTTP loopback is allowed)",
		);
	}
}

function toStripeAmount(amount: number, currency: string) {
	if (
		!Number.isSafeInteger(amount) ||
		amount <= 0 ||
		!/^[A-Z]{3}$/.test(currency)
	) {
		throw new Error(
			"Stripe checkout requires a positive amount in minor units and an uppercase currency",
		);
	}
	// These ISO three/four-decimal currencies are not documented Checkout presentment currencies.
	if (
		["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND", "CLF", "UYW"].includes(
			currency,
		)
	) {
		throw new Error("Stripe checkout does not support this currency");
	}
	// https://docs.stripe.com/currencies: legacy ISK/UGX use hundredths; MGA only supports whole units.
	if (currency === "MGA") {
		if (amount % 100 !== 0)
			throw new Error("Stripe requires whole MGA amounts");
		return amount / 100;
	}
	const encoded =
		currency === "ISK" || currency === "UGX" ? amount * 100 : amount;
	if (!Number.isSafeInteger(encoded))
		throw new Error("Stripe amount exceeds the supported integer range");
	return encoded;
}

/**
 * Sell catalog snapshots through one-time Stripe Checkout payments.
 * Configure Business orderTtlMs above 30 minutes (for example, one hour): Stripe
 * requires at least 30 minutes remaining when a Checkout Session is created.
 * Verified charge creation time is stable across webhook and browser retries.
 */
export function createStripeBusinessProvider(
	options: StripeBusinessProviderOptions,
): BusinessPaymentProvider {
	validateRedirect(options.returnURL);
	validateRedirect(options.cancelURL);
	return {
		async createCheckout(order) {
			const amount = toStripeAmount(order.amount, order.currency);
			const expiresAt = Math.floor(order.expiresAt.getTime() / 1000);
			const remaining = expiresAt - Math.ceil(Date.now() / 1000);
			if (
				!Number.isFinite(remaining) ||
				remaining < 30 * 60 ||
				remaining > 24 * 60 * 60
			) {
				throw new Error(
					"Stripe checkout requires 30 minutes to 24 hours remaining before order expiry",
				);
			}
			const successURL = appendQueryParams(
				options.returnURL,
				new URLSearchParams({
					orderId: order.id,
					reference: "{CHECKOUT_SESSION_ID}",
				}),
			).replace(
				"reference=%7BCHECKOUT_SESSION_ID%7D",
				"reference={CHECKOUT_SESSION_ID}",
			);
			const session = await options.stripeClient.checkout.sessions.create(
				{
					mode: "payment",
					client_reference_id: order.id,
					metadata: { businessOrderId: order.id },
					payment_intent_data: { metadata: { businessOrderId: order.id } },
					adaptive_pricing: { enabled: false },
					line_items: [
						{
							quantity: 1,
							price_data: {
								currency: order.currency.toLowerCase(),
								unit_amount: amount,
								product_data: { name: order.product.name },
							},
						},
					],
					expires_at: expiresAt,
					success_url: successURL,
					cancel_url: appendQueryParams(
						options.cancelURL,
						new URLSearchParams({ orderId: order.id }),
					),
				},
				{ idempotencyKey: order.id },
			);
			if (!session.url || !session.id) {
				throw new Error("Stripe returned no checkout URL");
			}
			return { providerOrderId: session.id, url: session.url };
		},
		async verifyPayment({ order, reference }) {
			if (!order.providerOrderId || reference !== order.providerOrderId) {
				throw new Error("Stripe payment does not belong to this checkout");
			}
			const amount = toStripeAmount(order.amount, order.currency);
			const session = await options.stripeClient.checkout.sessions.retrieve(
				reference,
				{ expand: ["payment_intent.latest_charge"] },
			);
			const payment = session.payment_intent;
			if (
				session.id !== order.providerOrderId ||
				session.client_reference_id !== order.id ||
				session.metadata?.businessOrderId !== order.id ||
				session.mode !== "payment" ||
				session.status !== "complete" ||
				session.payment_status !== "paid" ||
				session.amount_total !== amount ||
				session.currency?.toUpperCase() !== order.currency ||
				!payment ||
				typeof payment === "string" ||
				payment.status !== "succeeded" ||
				payment.amount_received !== amount ||
				payment.currency.toUpperCase() !== order.currency ||
				payment.metadata.businessOrderId !== order.id
			) {
				throw new Error(
					"Stripe checkout is unpaid or its payment details do not match the order",
				);
			}
			const charge = payment.latest_charge;
			if (
				!charge ||
				typeof charge === "string" ||
				charge.status !== "succeeded" ||
				!charge.paid ||
				!Number.isSafeInteger(charge.created) ||
				charge.created <= 0
			) {
				throw new Error("Stripe returned no verified successful charge");
			}
			const paidAt = new Date(charge.created * 1000);
			if (!Number.isFinite(paidAt.getTime())) {
				throw new Error("Stripe returned an invalid charge timestamp");
			}
			return {
				paymentId: payment.id,
				providerOrderId: session.id,
				amount: order.amount,
				currency: order.currency,
				paidAt,
			};
		},
	};
}
