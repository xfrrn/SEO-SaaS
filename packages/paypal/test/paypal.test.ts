import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalOptions } from "../src/index";
import { createPayPalClient, isPayPalOrderExpiredError } from "../src/index";

const credentials = {
	clientId: "test-client-id",
	clientSecret: "test-client-secret",
	webhookId: "test-webhook-id",
};
const orderInput = {
	requestId: "create-1",
	referenceId: "local-payment-1",
	amount: { currency_code: "USD", value: "9.90" },
	returnURL: "https://example.com/paypal/return",
	cancelURL: "https://example.com/paypal/cancel",
};
const fetchMock = vi.fn<typeof fetch>();

function respond(body: unknown, status = 200, headers?: HeadersInit) {
	const responseHeaders = new Headers(headers);
	responseHeaders.set("content-type", "application/json");
	return new Response(JSON.stringify(body), {
		status,
		headers: responseHeaders,
	});
}

function tokenThen(body: unknown, status = 200, headers?: HeadersInit) {
	fetchMock.mockResolvedValueOnce(
		respond({ access_token: "test-access-token", token_type: "Bearer" }),
	);
	fetchMock.mockResolvedValueOnce(respond(body, status, headers));
}

function sentBody(callIndex: number) {
	const init = fetchMock.mock.calls[callIndex]?.[1];
	expect(typeof init?.body).toBe("string");
	return JSON.parse(init!.body as string) as Record<string, unknown>;
}

function webhookHeaders() {
	return new Headers({
		"PAYPAL-AUTH-ALGO": "SHA256withRSA",
		"PAYPAL-CERT-URL": "https://api.paypal.com/v1/notifications/certs/test",
		"PAYPAL-TRANSMISSION-ID": "transmission-1",
		"PAYPAL-TRANSMISSION-SIG": "test-signature",
		"PAYPAL-TRANSMISSION-TIME": "2026-10-05T01:02:03Z",
	});
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** @see https://developer.paypal.com/docs/api/orders/v2/ */
describe("PayPal Orders SDK", () => {
	it.each([
		[undefined, "https://api-m.sandbox.paypal.com"],
		["sandbox", "https://api-m.sandbox.paypal.com"],
		["live", "https://api-m.paypal.com"],
	] as const)("creates an order in %s with server credentials and idempotency", async (environment, baseURL) => {
		const client = createPayPalClient({ ...credentials, environment });
		const order = { id: "ORDER123", status: "PAYER_ACTION_REQUIRED" };
		tokenThen(order);
		expect(await client.createOrder(orderInput)).toEqual(order);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [tokenURL, tokenInit] = fetchMock.mock.calls[0]!;
		expect(tokenURL).toBe(`${baseURL}/v1/oauth2/token`);
		expect(tokenInit?.method).toBe("POST");
		expect(new Headers(tokenInit?.headers).get("authorization")).toBe(
			`Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
		);
		expect(String(tokenInit?.body)).toBe("grant_type=client_credentials");
		const [orderURL, orderInit] = fetchMock.mock.calls[1]!;
		expect(orderURL).toBe(`${baseURL}/v2/checkout/orders`);
		expect(orderInit?.method).toBe("POST");
		const headers = new Headers(orderInit?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-access-token");
		expect(headers.get("paypal-request-id")).toBe(orderInput.requestId);
		expect(headers.get("prefer")).toBe("return=representation");
		expect(sentBody(1)).toMatchObject({
			intent: "CAPTURE",
			purchase_units: [
				{
					reference_id: orderInput.referenceId,
					custom_id: orderInput.referenceId,
					amount: orderInput.amount,
				},
			],
		});
		expect(String(orderInit?.body)).toContain(orderInput.returnURL);
		expect(String(orderInit?.body)).toContain(orderInput.cancelURL);
	});

	it("reads an order and preserves pending capture status", async () => {
		const client = createPayPalClient(credentials);
		const order = { id: "ORDER123", status: "APPROVED" };
		tokenThen(order);
		expect(await client.getOrder("ORDER123")).toEqual(order);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123",
		);
		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
		const pending = {
			id: "ORDER123",
			status: "COMPLETED",
			purchase_units: [
				{
					payments: {
						captures: [
							{
								id: "CAPTURE123",
								status: "PENDING",
								amount: orderInput.amount,
							},
						],
					},
				},
			],
		};
		tokenThen(pending);
		expect(
			await client.captureOrder({
				orderId: "ORDER123",
				requestId: "capture-1",
			}),
		).toEqual(pending);
		const [captureURL, captureInit] = fetchMock.mock.calls[3]!;
		expect(captureURL).toBe(
			"https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123/capture",
		);
		expect(captureInit?.method).toBe("POST");
		expect(new Headers(captureInit?.headers).get("paypal-request-id")).toBe(
			"capture-1",
		);
		expect(new Headers(captureInit?.headers).get("prefer")).toBe(
			"return=representation",
		);
	});

	it.each([
		"",
		"0",
		"0.00",
		"-1.00",
		"1e2",
		"1.001",
		"1.",
		".10",
		" 1.00",
	])("rejects invalid amount %s before HTTP", async (value) => {
		const client = createPayPalClient(credentials);
		await expect(
			client.createOrder({
				...orderInput,
				amount: { currency_code: "USD", value },
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"usd",
		"US",
		"USDD",
		"",
		"123",
	])("rejects invalid currency %s before HTTP", async (currency_code) => {
		const client = createPayPalClient(credentials);
		await expect(
			client.createOrder({
				...orderInput,
				amount: { currency_code, value: "1.00" },
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"JPY",
		"HUF",
		"TWD",
	])("requires whole-unit %s values", async (currency_code) => {
		const client = createPayPalClient(credentials);
		await expect(
			client.createOrder({
				...orderInput,
				amount: { currency_code, value: "10.50" },
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
		tokenThen({ id: "ORDER123", status: "CREATED" });
		await client.createOrder({
			...orderInput,
			amount: { currency_code, value: "10" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		"",
		"invalid key",
		"line\r\nbreak",
		"x".repeat(109),
	])("rejects invalid create and capture request IDs", async (requestId) => {
		const client = createPayPalClient(credentials);
		await expect(
			client.createOrder({ ...orderInput, requestId }),
		).rejects.toThrow();
		await expect(
			client.captureOrder({ orderId: "ORDER123", requestId }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"",
		"../orders",
		"ORDER/123",
		"ORDER?foo=bar",
		"x".repeat(65),
	])("rejects invalid read and capture order IDs", async (orderId) => {
		const client = createPayPalClient(credentials);
		await expect(client.getOrder(orderId)).rejects.toThrow();
		await expect(
			client.captureOrder({ orderId, requestId: "capture-1" }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"javascript:alert(1)",
		"http://example.com/return",
		"//example.com",
		"not-a-url",
	])("rejects unsafe return and cancellation URLs", async (url) => {
		const client = createPayPalClient(credentials);
		await expect(
			client.createOrder({ ...orderInput, returnURL: url }),
		).rejects.toThrow();
		await expect(
			client.createOrder({ ...orderInput, cancelURL: url }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows localhost HTTP for development", async () => {
		const client = createPayPalClient(credentials);
		tokenThen({ id: "ORDER123", status: "CREATED" });
		await client.createOrder({
			...orderInput,
			returnURL: "http://localhost:3000/paypal/return",
			cancelURL: "http://localhost:3000/paypal/cancel",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		{},
		{ access_token: "" },
		{ access_token: 123 },
	])("rejects malformed OAuth tokens without sending an order", async (token) => {
		const client = createPayPalClient(credentials);
		fetchMock.mockResolvedValueOnce(respond(token));
		await expect(client.createOrder(orderInput)).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reports API status and debug ID without leaking upstream contents", async () => {
		const client = createPayPalClient(credentials);
		tokenThen(
			{ message: "private upstream details", secret: credentials.clientSecret },
			502,
			{ "paypal-debug-id": "debug-test-123" },
		);
		const error = await client
			.createOrder(orderInput)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("502");
		expect(String(error)).toContain("debug-test-123");
		expect(String(error)).not.toContain("private upstream details");
		expect(String(error)).not.toContain(credentials.clientSecret);
		expect(String(error)).not.toContain("test-access-token");
	});

	it("does not swallow network errors", async () => {
		const client = createPayPalClient(credentials);
		const error = new Error("network unavailable");
		fetchMock.mockRejectedValueOnce(error);
		await expect(client.createOrder(orderInput)).rejects.toBe(error);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("PayPal business order expiration", () => {
	const createdAt = Date.UTC(2026, 9, 6);
	const ttlMs = 30 * 60 * 1000;
	const expiresAt = createdAt + ttlMs;

	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(createdAt);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("calculates the default or custom deadline from the original creation time", () => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		expect(client.calculateOrderExpiresAt(createdAt)).toBe(expiresAt);
		vi.mocked(Date.now).mockReturnValue(createdAt + 60_000);
		expect(client.calculateOrderExpiresAt(createdAt)).toBe(expiresAt);
		expect(
			createPayPalClient({
				...credentials,
				orderExpiration: { ttlMs: 10 * 60 * 1000 },
			}).calculateOrderExpiresAt(createdAt),
		).toBe(createdAt + 10 * 60 * 1000);
	});

	it.each([
		undefined,
		false,
	] as const)("preserves legacy create and capture calls with expiration %s", async (orderExpiration) => {
		const client = createPayPalClient({ ...credentials, orderExpiration });
		expect(client.calculateOrderExpiresAt(createdAt)).toBeUndefined();
		expect(() => client.assertOrderPayable()).not.toThrow();
		const order = { id: "ORDER123", status: "COMPLETED" };
		tokenThen(order);
		expect(await client.createOrder(orderInput)).toEqual(order);
		tokenThen(order);
		expect(
			await client.captureOrder({ orderId: order.id, requestId: "capture-1" }),
		).toEqual(order);
	});

	it.each([
		null,
		0,
		"true",
		{},
		[],
		{ ttlMs: undefined },
		{ ttlMs: null },
		{ ttlMs: 0 },
		{ ttlMs: -1 },
		{ ttlMs: 0.5 },
		{ ttlMs: "1800000" },
		{ ttlMs: Number.NaN },
		{ ttlMs: Number.POSITIVE_INFINITY },
		{ ttlMs: 8_640_000_000_000_001 },
	])("rejects invalid expiration configuration %j", (orderExpiration) => {
		expect(() =>
			createPayPalClient({
				...credentials,
				orderExpiration: orderExpiration as PayPalOptions["orderExpiration"],
			}),
		).toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		null,
		"2026-10-06T00:00:00Z",
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		8_640_000_000_000_001,
	])("rejects invalid creation and saved expiry timestamps %j", async (time) => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		const invalidTime = time as number;
		expect(() => client.calculateOrderExpiresAt(invalidTime)).toThrow();
		expect(() => client.assertOrderPayable(invalidTime)).toThrow();
		await expect(
			client.createOrder({ ...orderInput, expiresAt: invalidTime }),
		).rejects.toThrow();
		await expect(
			client.captureOrder({
				orderId: "ORDER123",
				requestId: "capture-1",
				expiresAt: invalidTime,
			}),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects date overflow while retaining valid timestamp boundaries", () => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		expect(client.calculateOrderExpiresAt(0)).toBe(ttlMs);
		expect(client.calculateOrderExpiresAt(8_640_000_000_000_000 - ttlMs)).toBe(
			8_640_000_000_000_000,
		);
		expect(() =>
			client.calculateOrderExpiresAt(8_640_000_000_000_001 - ttlMs),
		).toThrow();
	});

	it.each([
		-1, 0, 1,
	])("uses an inclusive deadline at expiry %i ms", (offset) => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		vi.mocked(Date.now).mockReturnValue(expiresAt + offset);
		if (offset < 0) {
			expect(() => client.assertOrderPayable(expiresAt)).not.toThrow();
			return;
		}
		let error: unknown;
		try {
			client.assertOrderPayable(expiresAt);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: "PayPalOrderExpiredError",
			code: "PAYPAL_ORDER_EXPIRED",
			expiresAt,
		});
		expect(isPayPalOrderExpiredError(error)).toBe(true);
		expect(isPayPalOrderExpiredError(new Error("network unavailable"))).toBe(
			false,
		);
		expect(isPayPalOrderExpiredError(null)).toBe(false);
	});

	it.each([
		true,
		false,
	] as const)("blocks expired create and capture before HTTP with expiration enabled=%s", async (orderExpiration) => {
		const client = createPayPalClient({ ...credentials, orderExpiration });
		vi.mocked(Date.now).mockReturnValue(expiresAt);
		for (const operation of [
			client.createOrder({ ...orderInput, expiresAt }),
			client.captureOrder({
				orderId: "ORDER123",
				requestId: "capture-1",
				expiresAt,
			}),
		]) {
			await expect(operation).rejects.toMatchObject({
				code: "PAYPAL_ORDER_EXPIRED",
				expiresAt,
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"create",
		"capture",
	] as const)("rechecks the deadline after OAuth before sending %s", async (operation) => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		fetchMock.mockImplementationOnce(async () => {
			vi.mocked(Date.now).mockReturnValue(expiresAt);
			return respond({ access_token: "test-access-token" });
		});
		await expect(
			operation === "create"
				? client.createOrder({ ...orderInput, expiresAt })
				: client.captureOrder({
						orderId: "ORDER123",
						requestId: "capture-1",
						expiresAt,
					}),
		).rejects.toMatchObject({ code: "PAYPAL_ORDER_EXPIRED" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toContain("/v1/oauth2/token");
	});

	it("reuses the saved expiry and request ID when restoring and retrying orders", async () => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		const saved = {
			...orderInput,
			expiresAt: client.calculateOrderExpiresAt(createdAt),
		};
		const order = { id: "ORDER123", status: "CREATED" };
		tokenThen(order);
		await client.createOrder(saved);
		vi.mocked(Date.now).mockReturnValue(expiresAt - 1);
		const restored = createPayPalClient({
			...credentials,
			orderExpiration: { ttlMs: ttlMs * 2 },
		});
		tokenThen(order);
		await restored.createOrder(saved);
		expect(sentBody(3)).toEqual(sentBody(1));
		expect(sentBody(3)).not.toHaveProperty("expiresAt");
		for (const callIndex of [1, 3]) {
			expect(
				new Headers(fetchMock.mock.calls[callIndex]?.[1]?.headers).get(
					"paypal-request-id",
				),
			).toBe(saved.requestId);
		}
		vi.mocked(Date.now).mockReturnValue(expiresAt);
		await expect(restored.createOrder(saved)).rejects.toMatchObject({
			code: "PAYPAL_ORDER_EXPIRED",
			expiresAt,
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it.each([
		"COMPLETED",
		"PENDING",
	])("preserves a %s capture response that arrives after expiration", async (status) => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		const order = {
			id: "ORDER123",
			status: "COMPLETED",
			purchase_units: [
				{
					payments: {
						captures: [{ id: "CAPTURE123", status, amount: orderInput.amount }],
					},
				},
			],
		};
		fetchMock.mockResolvedValueOnce(respond({ access_token: "test-token" }));
		fetchMock.mockImplementationOnce(async () => {
			vi.mocked(Date.now).mockReturnValue(expiresAt + 1);
			return respond(order);
		});
		expect(
			await client.captureOrder({
				orderId: order.id,
				requestId: "capture-1",
				expiresAt,
			}),
		).toEqual(order);
		expect(sentBody(1)).toEqual({});
		expect(
			new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
				"paypal-request-id",
			),
		).toBe("capture-1");
	});

	it("preserves an uncertain capture network error across expiration", async () => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		const savedCapture = {
			orderId: "ORDER123",
			requestId: "capture-1",
			expiresAt,
		};
		const error = new Error("capture response lost");
		fetchMock.mockResolvedValueOnce(respond({ access_token: "test-token" }));
		fetchMock.mockImplementationOnce(async () => {
			vi.mocked(Date.now).mockReturnValue(expiresAt + 1);
			throw error;
		});
		await expect(client.captureOrder(savedCapture)).rejects.toBe(error);
		expect(isPayPalOrderExpiredError(error)).toBe(false);
		await expect(client.captureOrder(savedCapture)).rejects.toMatchObject({
			code: "PAYPAL_ORDER_EXPIRED",
			expiresAt,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const completedOrder = {
			id: savedCapture.orderId,
			status: "COMPLETED",
			purchase_units: [
				{
					payments: {
						captures: [
							{
								id: "CAPTURE123",
								status: "COMPLETED",
								amount: orderInput.amount,
							},
						],
					},
				},
			],
		};
		tokenThen(completedOrder);
		expect(await client.getOrder(savedCapture.orderId)).toEqual(completedOrder);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("allows order reconciliation and delayed webhook verification after expiration", async () => {
		const client = createPayPalClient({
			...credentials,
			orderExpiration: true,
		});
		vi.mocked(Date.now).mockReturnValue(expiresAt + 1);
		const order = { id: "ORDER123", status: "COMPLETED" };
		tokenThen(order);
		expect(await client.getOrder(order.id)).toEqual(order);
		const event = {
			id: "WH-DELAYED",
			event_type: "PAYMENT.CAPTURE.COMPLETED",
			resource: { id: "CAPTURE123", status: "COMPLETED" },
		};
		tokenThen({ verification_status: "SUCCESS" });
		expect(
			await client.verifyWebhook({
				headers: webhookHeaders(),
				body: JSON.stringify(event),
			}),
		).toEqual(event);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});
});

/** @see https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature */
describe("PayPal webhook verification", () => {
	const event = {
		id: "WH-EVENT-1",
		event_type: "PAYMENT.CAPTURE.COMPLETED",
		resource: {
			id: "CAPTURE123",
			status: "COMPLETED",
			amount: { currency_code: "USD", value: "9.90" },
			extra_provider_field: { keep: "original" },
		},
		links: [{ href: "https://example.com/event", rel: "self" }],
	};

	it("verifies all signature headers and forwards the complete original event", async () => {
		const client = createPayPalClient(credentials);
		tokenThen({ verification_status: "SUCCESS" });
		expect(
			await client.verifyWebhook({
				headers: webhookHeaders(),
				body: JSON.stringify(event),
			}),
		).toEqual(event);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
		);
		expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
		expect(sentBody(1)).toEqual({
			auth_algo: "SHA256withRSA",
			cert_url: "https://api.paypal.com/v1/notifications/certs/test",
			transmission_id: "transmission-1",
			transmission_sig: "test-signature",
			transmission_time: "2026-10-05T01:02:03Z",
			webhook_id: credentials.webhookId,
			webhook_event: event,
		});
	});

	it("preserves raw event formatting, numeric literals and string escapes for verification", async () => {
		const client = createPayPalClient(credentials);
		const body =
			'{\n "id": "WH-1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {"value": 1.00, "label": "\\u0041", "large": 9007199254740993}\n}';
		tokenThen({ verification_status: "SUCCESS" });
		await client.verifyWebhook({ headers: webhookHeaders(), body });
		expect(fetchMock.mock.calls[1]?.[1]?.body).toContain(
			`"webhook_event":${body}`,
		);
	});

	it.each([
		"PAYPAL-AUTH-ALGO",
		"PAYPAL-CERT-URL",
		"PAYPAL-TRANSMISSION-ID",
		"PAYPAL-TRANSMISSION-SIG",
		"PAYPAL-TRANSMISSION-TIME",
	])("rejects missing signature header %s before HTTP", async (name) => {
		const client = createPayPalClient(credentials);
		const headers = webhookHeaders();
		headers.delete(name);
		await expect(
			client.verifyWebhook({ headers, body: JSON.stringify(event) }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"{",
		"null",
		"[]",
		'"text"',
		"{}",
		'{"id":"WH-EVENT-1"}',
	])("rejects malformed webhook events before HTTP", async (body) => {
		const client = createPayPalClient(credentials);
		await expect(
			client.verifyWebhook({ headers: webhookHeaders(), body }),
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"FAILURE",
		"PENDING",
		"success",
		undefined,
	])("rejects any verification result other than SUCCESS", async (verification_status) => {
		const client = createPayPalClient(credentials);
		tokenThen({ verification_status });
		await expect(
			client.verifyWebhook({
				headers: webhookHeaders(),
				body: JSON.stringify(event),
			}),
		).rejects.toThrow();
	});
});
