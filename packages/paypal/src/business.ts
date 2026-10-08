import type { BusinessOrder, BusinessPaymentProvider } from "@app/business";
import { appendQueryParams } from "@better-auth/core/utils/url";
import type { createPayPalClient, PayPalAmount, PayPalOrder } from "./index";

// https://developer.paypal.com/reports/reference/supported-currencies
const currencies = new Set([
	"AUD",
	"BRL",
	"CAD",
	"CNY",
	"CZK",
	"DKK",
	"EUR",
	"HKD",
	"HUF",
	"ILS",
	"JPY",
	"MYR",
	"MXN",
	"TWD",
	"NZD",
	"NOK",
	"PHP",
	"PLN",
	"GBP",
	"SGD",
	"SEK",
	"CHF",
	"THB",
	"USD",
]);

function paypalAmount(order: BusinessOrder): PayPalAmount {
	if (
		!currencies.has(order.currency) ||
		!Number.isSafeInteger(order.amount) ||
		order.amount <= 0
	) {
		throw new Error("Unsupported PayPal currency or amount");
	}
	// Business catalog uses ISO minor units; PayPal additionally requires whole HUF/TWD.
	const digits = order.currency === "JPY" ? 0 : 2;
	const units = String(order.amount).padStart(digits + 1, "0");
	let value = digits
		? `${units.slice(0, -digits)}.${units.slice(-digits)}`
		: units;
	if (["HUF", "TWD"].includes(order.currency)) {
		if (!value.endsWith(".00"))
			throw new Error("PayPal requires whole HUF and TWD amounts");
		value = value.slice(0, -3);
	}
	if (!/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) {
		throw new Error("PayPal amount exceeds the supported range");
	}
	return { currency_code: order.currency, value };
}

function matchesAmount(
	value: PayPalAmount | undefined,
	expected: PayPalAmount,
) {
	if (
		!value ||
		value.currency_code !== expected.currency_code ||
		!/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value.value)
	)
		return false;
	const normalize = (amount: string) => {
		const [whole, fraction = ""] = amount.split(".");
		return `${whole}.${fraction.padEnd(2, "0")}`;
	};
	return normalize(value.value) === normalize(expected.value);
}

function ownedUnit(
	remote: PayPalOrder,
	order: BusinessOrder,
	captured = false,
) {
	const unit = remote.purchase_units?.[0];
	if (
		remote.id !== order.providerOrderId ||
		remote.purchase_units?.length !== 1 ||
		!unit ||
		((!captured || unit.custom_id !== undefined) &&
			unit.custom_id !== order.id) ||
		unit.reference_id !== order.id
	) {
		throw new Error("PayPal order does not match the business order");
	}
	return unit;
}

/** Connect persisted Business orders to PayPal's existing single-payment checkout. */
export function createPayPalBusinessProvider(options: {
	client: ReturnType<typeof createPayPalClient>;
	returnURL: string;
	cancelURL: string;
}): BusinessPaymentProvider {
	if (
		[options.returnURL, options.cancelURL].some((url) =>
			new URL(url).searchParams.has("orderId"),
		)
	) {
		throw new Error("PayPal return and cancel URLs must not contain orderId");
	}
	return {
		async createCheckout(order) {
			const remote = await options.client.createOrder({
				requestId: order.id,
				referenceId: order.id,
				amount: paypalAmount(order),
				returnURL: appendQueryParams(
					options.returnURL,
					new URLSearchParams({ orderId: order.id }),
				),
				cancelURL: appendQueryParams(
					options.cancelURL,
					new URLSearchParams({ orderId: order.id }),
				),
				description: order.product.name.slice(0, 127),
				expiresAt: order.expiresAt.getTime(),
			});
			const link =
				remote.links?.find((entry) => entry.rel === "payer-action") ??
				remote.links?.find((entry) => entry.rel === "approve");
			if (!link) throw new Error("PayPal did not return an approval URL");
			const url = new URL(link.href);
			if (
				url.protocol !== "https:" ||
				url.username ||
				url.password ||
				!(url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com"))
			) {
				throw new Error("Invalid PayPal approval URL");
			}
			return { providerOrderId: remote.id, url: url.href };
		},
		async verifyPayment({ order, reference }) {
			if (!order.providerOrderId || reference !== order.providerOrderId) {
				throw new Error("PayPal reference does not match the business order");
			}
			const amount = paypalAmount(order);
			let remote = await options.client.getOrder(order.providerOrderId);
			let unit = ownedUnit(remote, order);
			if (remote.status === "APPROVED") {
				if (!matchesAmount(unit.amount, amount))
					throw new Error("PayPal order amount does not match");
				remote = await options.client.captureOrder({
					orderId: order.providerOrderId,
					requestId: `capture-${order.id}`,
					expiresAt: order.expiresAt.getTime(),
				});
				// Capture representations may omit custom_id, already verified by the lookup.
				unit = ownedUnit(remote, order, true);
			}
			const capture = unit.payments?.captures?.[0];
			const paidAt = new Date(capture?.create_time ?? "");
			if (
				remote.status !== "COMPLETED" ||
				unit.payments?.captures?.length !== 1 ||
				!capture?.id ||
				capture.status !== "COMPLETED" ||
				!matchesAmount(capture.amount, amount) ||
				!Number.isFinite(paidAt.getTime())
			) {
				throw new Error("PayPal payment is not a verified full capture");
			}
			return {
				paymentId: capture.id,
				providerOrderId: remote.id,
				amount: order.amount,
				currency: order.currency,
				paidAt,
			};
		},
	};
}
