import type { BusinessOrder } from "@app/business";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPayPalBusinessProvider, createPayPalClient } from "../src/index";

const now = new Date("2026-10-08T12:00:00Z");
const order: BusinessOrder = {
	id: "business-order-1",
	referenceId: "customer-1",
	checkoutKey: "checkout-1",
	provider: "paypal",
	productId: "product-1",
	productKey: "credits",
	parentOrderId: null,
	product: {
		id: "product-1",
		key: "credits",
		name: "Credit pack",
		type: "credits",
		amount: 990,
		currency: "USD",
		credits: 100,
		membershipDays: null,
		creditValidityDays: null,
		limits: {},
		published: true,
		version: 1,
		createdAt: now.toISOString(),
	},
	amount: 990,
	currency: "USD",
	status: "pending",
	providerOrderId: "ORDER123",
	providerKey: "paypal:ORDER123",
	checkoutURL: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
	paymentId: null,
	paidAt: null,
	periodStart: null,
	periodEnd: null,
	refundedAmount: 0,
	reviewRequired: false,
	createdAt: now,
	expiresAt: new Date(now.getTime() + 30 * 60_000),
	fulfilledAt: null,
};
const fetchMock = vi.fn<typeof fetch>();
const client = createPayPalClient({
	clientId: "test-client",
	clientSecret: "test-secret",
	webhookId: "test-webhook",
	orderExpiration: true,
});
const provider = createPayPalBusinessProvider({
	client,
	returnURL: "http://127.0.0.1:3001/payment/return?source=shop#result",
	cancelURL: "http://127.0.0.1:3001/",
});
const unit = {
	reference_id: order.id,
	custom_id: order.id,
	amount: { currency_code: "USD", value: "9.90" },
};
const completed = {
	id: "ORDER123",
	status: "COMPLETED",
	purchase_units: [
		{
			...unit,
			payments: {
				captures: [
					{
						id: "CAPTURE123",
						status: "COMPLETED",
						amount: unit.amount,
						create_time: "2026-10-08T12:01:00Z",
					},
				],
			},
		},
	],
};

function respond(body: unknown) {
	fetchMock.mockResolvedValueOnce(
		Response.json({ access_token: "test-token" }),
	);
	fetchMock.mockResolvedValueOnce(Response.json(body));
}
function body(index: number) {
	return JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body)) as {
		purchase_units: { amount: { currency_code: string; value: string } }[];
		payment_source: {
			paypal: {
				experience_context: { return_url: string; cancel_url: string };
			};
		};
	};
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(Date, "now").mockReturnValue(now.getTime());
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** @see https://developer.paypal.com/api/orders/v2/orders-capture */
describe("PayPal business provider", () => {
	it("creates checkout from persisted amounts and appends its own callback order ID", async () => {
		respond({
			id: "ORDER123",
			status: "PAYER_ACTION_REQUIRED",
			links: [{ rel: "payer-action", href: order.checkoutURL }],
		});
		expect(await provider.createCheckout(order)).toEqual({
			providerOrderId: "ORDER123",
			url: order.checkoutURL,
		});
		expect(body(1).purchase_units).toEqual([
			{
				...unit,
				description: "Credit pack",
			},
		]);
		expect(
			new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
				"paypal-request-id",
			),
		).toBe(order.id);
		expect(body(1).payment_source.paypal.experience_context.return_url).toBe(
			"http://127.0.0.1:3001/payment/return?source=shop&orderId=business-order-1#result",
		);
		expect(body(1).payment_source.paypal.experience_context.cancel_url).toBe(
			"http://127.0.0.1:3001/?orderId=business-order-1",
		);
	});

	it("queries an approved order before capture and uses a stable capture idempotency key", async () => {
		respond({ id: "ORDER123", status: "APPROVED", purchase_units: [unit] });
		respond({
			...completed,
			purchase_units: [
				{
					reference_id: order.id,
					payments: completed.purchase_units[0]!.payments,
				},
			],
		});
		expect(
			await provider.verifyPayment({ order, reference: "ORDER123" }),
		).toEqual({
			paymentId: "CAPTURE123",
			providerOrderId: "ORDER123",
			amount: 990,
			currency: "USD",
			paidAt: new Date("2026-10-08T12:01:00Z"),
		});
		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
		expect(fetchMock.mock.calls[3]?.[0]).toContain("/ORDER123/capture");
		expect(
			new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get(
				"paypal-request-id",
			),
		).toBe(`capture-${order.id}`);
	});

	it("reconciles completed payment after local expiry without another capture", async () => {
		vi.mocked(Date.now).mockReturnValue(order.expiresAt.getTime() + 1);
		respond(completed);
		await expect(
			provider.verifyPayment({ order, reference: "ORDER123" }),
		).resolves.toMatchObject({ paymentId: "CAPTURE123" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("refuses mismatched references without HTTP and unrelated approved orders before capture", async () => {
		await expect(
			provider.verifyPayment({ order, reference: "OTHER" }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
		for (const replacement of [
			{ ...unit, custom_id: "someone-else" },
			{ ...unit, reference_id: "someone-else" },
			{ ...unit, amount: { currency_code: "USD", value: "9.89" } },
			{ ...unit, amount: { currency_code: "EUR", value: "9.90" } },
		]) {
			fetchMock.mockReset();
			respond({
				id: "ORDER123",
				status: "APPROVED",
				purchase_units: [replacement],
			});
			await expect(
				provider.verifyPayment({ order, reference: "ORDER123" }),
			).rejects.toThrow();
			expect(fetchMock).toHaveBeenCalledTimes(2);
		}
	});

	it("does not capture an expired approved order or fulfill pending and malformed captures", async () => {
		vi.mocked(Date.now).mockReturnValue(order.expiresAt.getTime());
		respond({ id: "ORDER123", status: "APPROVED", purchase_units: [unit] });
		await expect(
			provider.verifyPayment({ order, reference: "ORDER123" }),
		).rejects.toMatchObject({ code: "PAYPAL_ORDER_EXPIRED" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const changes of [
			{ status: "PENDING" },
			{ create_time: undefined },
			{ create_time: "invalid" },
			{ amount: { currency_code: "USD", value: "9.89" } },
		]) {
			respond({
				...completed,
				purchase_units: [
					{
						...unit,
						payments: {
							captures: [
								{
									...completed.purchase_units[0]!.payments.captures[0],
									...changes,
								},
							],
						},
					},
				],
			});
			await expect(
				provider.verifyPayment({ order, reference: "ORDER123" }),
			).rejects.toThrow();
		}
	});

	it("enforces a persisted expiry even when the standalone client has expiration disabled", async () => {
		const noExpiration = createPayPalBusinessProvider({
			client: createPayPalClient({
				clientId: "test-client",
				clientSecret: "test-secret",
				webhookId: "test-webhook",
				orderExpiration: false,
			}),
			returnURL: "https://example.com/payment/return",
			cancelURL: "https://example.com/",
		});
		vi.mocked(Date.now).mockReturnValue(order.expiresAt.getTime());
		respond({ id: "ORDER123", status: "APPROVED", purchase_units: [unit] });
		await expect(
			noExpiration.verifyPayment({ order, reference: "ORDER123" }),
		).rejects.toMatchObject({ code: "PAYPAL_ORDER_EXPIRED" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	/** @see https://developer.paypal.com/reports/reference/supported-currencies */
	it.each([
		["USD", 101, "1.01"],
		["JPY", 101, "101"],
		["HUF", 10100, "101"],
		["TWD", 10100, "101"],
		["USD", 999999999999999, "9999999999999.99"],
	])("preserves exact ISO minor units for %s", async (currency, amount, value) => {
		respond({
			id: "ORDER123",
			status: "CREATED",
			links: [{ rel: "approve", href: order.checkoutURL }],
		});
		await provider.createCheckout({
			...order,
			currency: String(currency),
			amount: Number(amount),
		});
		expect(body(1).purchase_units[0]?.amount).toEqual({
			currency_code: currency,
			value,
		});
	});

	it.each([
		["XYZ", 100],
		["HUF", 101],
		["TWD", 101],
		["USD", 0],
		["USD", Number.MAX_SAFE_INTEGER],
		["USD", 1.1],
	])("rejects unsupported or unrepresentable %s amounts before HTTP", async (currency, amount) => {
		await expect(
			provider.createCheckout({
				...order,
				currency: String(currency),
				amount: Number(amount),
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects unsafe approval links", async () => {
		respond({
			id: "ORDER123",
			status: "CREATED",
			links: [{ rel: "approve", href: "https://paypal.com.attacker.test/" }],
		});
		await expect(provider.createCheckout(order)).rejects.toThrow();
	});
});
