import type { BusinessOrder, BusinessPaymentProvider } from "@app/business";
import { appendQueryParams } from "@better-auth/core/utils/url";
import type { TaxCategory, WaffoPancake } from "@waffo/pancake-ts";
import { inspectWaffoCheckout } from "./checkout-state";

/** Server-owned Waffo product, store and environment; the product must be one-time. */
export interface WaffoBusinessProviderOptions {
	client: WaffoPancake;
	storeId: string;
	/** Legacy fallback for product snapshots without a Waffo binding. */
	productId?: string;
	environment: "test" | "prod";
	taxCategory: TaxCategory;
	/** Absolute HTTPS URL; Waffo's payment channel does not accept HTTP loopback. */
	returnURL: string;
	/** Optional HTTP boundary for the hosted cashier's read-only session inspection. */
	fetch?: typeof fetch;
}

function currencyDigits(currency: string) {
	// Pancake's current one-time checkout currency matrix, not all ISO currencies.
	if (!["USD", "EUR", "GBP", "HKD", "JPY", "CNY"].includes(currency))
		throw new Error("Unsupported Waffo checkout currency");
	return currency === "JPY" ? 0 : 2;
}

function displayAmount(amount: number, currency: string) {
	const digits = currencyDigits(currency);
	if (!Number.isSafeInteger(amount) || amount <= 0)
		throw new Error("Waffo checkout requires a positive amount in minor units");
	const units = String(amount).padStart(digits + 1, "0");
	return digits ? `${units.slice(0, -digits)}.${units.slice(-digits)}` : units;
}

function minorAmount(value: string, currency: string) {
	const digits = currencyDigits(currency);
	if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
		throw new Error("Invalid Waffo payment amount");
	const [whole, fraction = ""] = value.split(".");
	if (fraction.slice(digits).replace(/0/g, ""))
		throw new Error("Invalid Waffo payment precision");
	return BigInt(whole! + fraction.slice(0, digits).padEnd(digits, "0"));
}

interface PaymentQuery {
	payments: {
		id: string;
		orderId: string;
		orderMerchantExternalId: string;
		status: string;
		createdAt: string;
		snapshotAmountDetails: {
			currency: string;
			subtotal: string;
			taxAmount: string;
			total: string;
		};
		onetimeOrder: {
			id: string;
			status: string;
			testMode: boolean;
			store: { id: string };
			onetimeProduct: { id: string };
		} | null;
	}[];
}

/**
 * One-time checkout for catalog credits/memberships. Catalog amounts are pre-tax;
 * Pancake adds tax at checkout. Fulfillment reconciles the verified subtotal.
 * Webhook deliveries and browser completion share Business's durable payment deduplication.
 */
export function createWaffoBusinessProvider(
	options: WaffoBusinessProviderOptions,
): BusinessPaymentProvider & {
	/** Verify the raw signed delivery; use its order ID to load the saved checkout reference. */
	verifyWebhook(request: Request): Promise<{ orderId: string } | null>;
} {
	const redirect = new URL(options.returnURL);
	if (
		redirect.protocol !== "https:" ||
		redirect.username ||
		redirect.password ||
		redirect.searchParams.has("orderId") ||
		redirect.searchParams.has("reference")
	)
		throw new Error("Waffo returnURL must be HTTPS without orderId/reference");
	if (!options.storeId || !["test", "prod"].includes(options.environment))
		throw new Error("Waffo requires a store and explicit environment");
	function productIdFor(order: BusinessOrder) {
		const payments = order.product.limits.payments;
		if (
			payments !== undefined &&
			(!payments || typeof payments !== "object" || Array.isArray(payments))
		)
			throw new Error("Invalid Waffo product binding");
		const binding = payments?.waffo;
		if (
			binding !== undefined &&
			(!binding || typeof binding !== "object" || Array.isArray(binding))
		)
			throw new Error("Invalid Waffo product binding");
		// An explicit null clears a binding; only legacy snapshots use the global fallback.
		const id = binding === undefined ? options.productId : binding.productId;
		if (
			typeof id !== "string" ||
			id.length > 128 ||
			!/^PROD_[A-Za-z0-9]+$/.test(id)
		)
			throw new Error("Waffo product ID is not configured or invalid");
		return id;
	}
	return {
		inspectCheckout(order, inspection) {
			return inspectWaffoCheckout(
				options,
				order,
				productIdFor(order),
				inspection?.closeIfUnpaid,
			);
		},
		async createCheckout(order) {
			const productId = productIdFor(order);
			const amount = displayAmount(order.amount, order.currency);
			const remaining = Math.floor(
				(order.expiresAt.getTime() - Date.now()) / 1000,
			);
			// The provider caches checkout creation for 24 hours; do not allow a longer local attempt.
			if (!Number.isFinite(remaining) || remaining < 60 || remaining > 86400)
				throw new Error(
					"Waffo checkout requires 1 minute to 24 hours before expiry",
				);
			const product = await options.client.graphql.query<{
				onetimeProduct: {
					id: string;
					status: string;
					store: { id: string };
				} | null;
			}>({
				query: `query ($id: String!) { onetimeProduct(id: $id) { id status store { id } } }`,
				variables: { id: productId },
			});
			if (
				product.errors?.length ||
				product.data?.onetimeProduct?.id !== productId ||
				product.data.onetimeProduct.store.id !== options.storeId ||
				product.data.onetimeProduct.status !== "active"
			)
				throw new Error(
					"Waffo requires an active one-time product in the configured store",
				);
			const session = await options.client.checkout.createSession(
				{
					productId,
					currency: order.currency,
					priceSnapshot: { amount, taxCategory: options.taxCategory },
					orderMerchantExternalId: order.id,
					metadata: {
						businessOrderId: order.id,
						businessProductId: order.productId,
					},
					successUrl: appendQueryParams(
						options.returnURL,
						new URLSearchParams({ orderId: order.id }),
					),
					expiresInSeconds: remaining,
				},
				{ idempotencyKey: order.id },
			);
			const url = new URL(session.checkoutUrl);
			if (
				!session.sessionId ||
				url.protocol !== "https:" ||
				url.username ||
				url.password
			)
				throw new Error("Invalid Waffo checkout response");
			return { providerOrderId: session.sessionId, url: url.href };
		},
		async verifyPayment({ order, reference }) {
			const productId = productIdFor(order);
			if (!order.providerOrderId || reference !== order.providerOrderId)
				throw new Error("Waffo reference does not match the saved checkout");
			displayAmount(order.amount, order.currency);
			const result = await options.client.graphql.query<PaymentQuery>({
				query: `query ($ref: String!) {
					payments(filter: { orderMerchantExternalId: { eq: $ref }, status: { eq: "succeeded" } }, limit: 2) {
						id orderId orderMerchantExternalId status createdAt
						snapshotAmountDetails { currency subtotal taxAmount total }
						onetimeOrder { id status testMode store { id } onetimeProduct { id } }
					}
				}`,
				variables: { ref: order.id },
			});
			if (result.errors?.length || result.data?.payments?.length !== 1)
				throw new Error(
					"Waffo requires exactly one verified successful payment",
				);
			const payment = result.data.payments[0]!;
			const remote = payment.onetimeOrder;
			const price = payment.snapshotAmountDetails;
			const paidAt = new Date(payment.createdAt);
			if (
				!payment.id ||
				!remote?.id ||
				payment.orderId !== remote.id ||
				payment.orderMerchantExternalId !== order.id ||
				payment.status !== "succeeded" ||
				remote.status !== "completed" ||
				remote.testMode !== (options.environment === "test") ||
				remote.store.id !== options.storeId ||
				remote.onetimeProduct.id !== productId ||
				price?.currency !== order.currency ||
				!Number.isFinite(paidAt.getTime()) ||
				minorAmount(price.subtotal, order.currency) !== BigInt(order.amount) ||
				minorAmount(price.total, order.currency) !==
					BigInt(order.amount) + minorAmount(price.taxAmount, order.currency)
			)
				throw new Error(
					"Waffo payment details do not match the business order",
				);
			return {
				paymentId: payment.id,
				providerOrderId: reference,
				amount: order.amount,
				currency: order.currency,
				paidAt,
			};
		},
		async verifyWebhook(request) {
			const signature = request.headers.get("x-waffo-signature");
			if (!signature) throw new Error("Missing Waffo signature");
			const event = options.client.webhooks.verify(
				await request.text(),
				signature,
				{ environment: options.environment },
			);
			if (
				event.mode !== options.environment ||
				event.storeId !== options.storeId
			)
				throw new Error("Waffo webhook environment or store does not match");
			if (event.eventType !== "order.completed") return null;
			const orderId = event.data.orderMerchantExternalId;
			if (orderId === undefined) return null;
			if (typeof orderId !== "string" || !orderId)
				throw new Error("Invalid Waffo merchant order reference");
			return { orderId };
		},
	};
}
