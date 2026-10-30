import type { BusinessOrder } from "@app/business";
import type { WaffoBusinessProviderOptions } from "./business";

/** A consumed hosted session plus no active merchant order proves this attempt cannot be paid again. */
export async function inspectWaffoCheckout(
	options: WaffoBusinessProviderOptions,
	order: BusinessOrder,
	productId: string,
	closeIfUnpaid = false,
): Promise<{ state: "open" | "closed" | "paid" | "unknown" }> {
	if (!order.providerOrderId || !order.checkoutURL) return { state: "unknown" };
	const result = await options.client.graphql.query<{
		store: { id: string; slug: string } | null;
		onetimeOrders: {
			id: string;
			orderMerchantExternalId: string;
			status: string;
			buyerEmail?: string;
			merchantProvidedBuyerIdentity?: string;
			payments?: { id: string; status: string }[];
			testMode: boolean;
			store: { id: string };
			onetimeProduct: { id: string };
		}[];
	}>({
		query: `query ($store: String!, $ref: String!) {
			store(id: $store) { id slug }
			onetimeOrders(storeId: $store, filter: { orderMerchantExternalId: { eq: $ref } }, limit: 2) {
				id orderMerchantExternalId status testMode buyerEmail merchantProvidedBuyerIdentity store { id } onetimeProduct { id } payments { id status }
			}
		}`,
		variables: { store: options.storeId, ref: order.id },
	});
	const data = result.data;
	if (
		result.errors?.length ||
		!data?.store ||
		data.store.id !== options.storeId ||
		!Array.isArray(data.onetimeOrders) ||
		data.onetimeOrders.length > 1 ||
		data.onetimeOrders.some(
			(row) =>
				!row.id ||
				row.orderMerchantExternalId !== order.id ||
				row.store?.id !== options.storeId ||
				row.onetimeProduct?.id !== productId ||
				row.testMode !== (options.environment === "test"),
		)
	)
		return { state: "unknown" };
	if (data.onetimeOrders.some((row) => row.status === "completed"))
		return { state: "paid" };
	if (
		data.onetimeOrders.some((row) =>
			row.payments?.some((payment) => payment.status === "succeeded"),
		)
	)
		return { state: "paid" };
	if (
		data.onetimeOrders.some(
			(row) => !["pending", "canceled"].includes(row.status),
		)
	)
		return { state: "unknown" };
	const waiting = data.onetimeOrders.find((row) => row.status === "pending");
	if (
		waiting &&
		(!closeIfUnpaid ||
			!waiting.payments?.length ||
			waiting.payments.some(
				(payment) =>
					!payment.id || !["failed", "canceled"].includes(payment.status),
			))
	)
		return { state: "unknown" };
	const url = new URL(order.checkoutURL);
	const path = `/store/${encodeURIComponent(data.store.slug)}/checkout/${encodeURIComponent(order.providerOrderId)}`;
	if (
		url.protocol !== "https:" ||
		url.hostname !== "pancake.waffo.ai" ||
		url.port ||
		url.username ||
		url.password ||
		url.pathname !== path
	)
		return { state: "unknown" };
	// The hosted cashier uses this read-only bootstrap; schema/network errors never release eligibility.
	const probe = new URL("/api/checkout/bootstrap", url.origin);
	probe.search = new URLSearchParams({
		slug: data.store.slug,
		session: order.providerOrderId,
		env: options.environment,
	}).toString();
	const response = await (options.fetch ?? fetch)(probe, {
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) return { state: "unknown" };
	const body = (await response.json()) as {
		sessionResult?: {
			status?: number;
			errors?: unknown[];
			data?: { checkoutSession?: unknown };
		};
	};
	const session = body.sessionResult;
	if (
		session?.status !== 200 ||
		session.errors?.length ||
		!session.data ||
		!("checkoutSession" in session.data)
	)
		return { state: "unknown" };
	if (session.data.checkoutSession !== null) return { state: "open" };
	const pending = data.onetimeOrders.find((row) => row.status === "pending");
	if (!pending) return { state: "closed" };
	// Only explicit retry can close a consumed failed attempt; passive polling never cancels.
	if (
		!closeIfUnpaid ||
		!pending.payments?.length ||
		pending.payments.some(
			(payment) =>
				!payment.id || !["failed", "canceled"].includes(payment.status),
		)
	)
		return { state: "unknown" };
	const identity = pending.merchantProvidedBuyerIdentity || pending.buyerEmail;
	if (!identity) return { state: "unknown" };
	const token = await options.client.auth.issueSessionToken({
		storeId: options.storeId,
		buyerIdentity: identity,
	});
	const canceled = await options.client
		.customer(token.token, { environment: options.environment })
		.cancelOnetimeOrder(
			{ orderId: pending.id },
			{ idempotencyKey: `close-${order.id}` },
		);
	if (canceled.orderId !== pending.id || canceled.status !== "canceled")
		return { state: "unknown" };
	const confirmed = await options.client.graphql.query<{
		onetimeOrder: {
			id: string;
			status: string;
			orderMerchantExternalId: string;
		} | null;
	}>({
		query:
			"query ($id: String!) { onetimeOrder(id: $id) { id status orderMerchantExternalId } }",
		variables: { id: pending.id },
	});
	const original = confirmed.data?.onetimeOrder;
	return {
		state:
			!confirmed.errors?.length &&
			original?.id === pending.id &&
			original.orderMerchantExternalId === order.id &&
			original.status === "canceled"
				? "closed"
				: "unknown",
	};
}
