import type { PayPalOrder } from "@app/auth-sdk/paypal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	capturePayment,
	createPayment,
	paidAccess,
	receiveWebhook,
} from "./paypal/lib/paypal";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	query: vi.fn(),
	release: vi.fn(),
	connect: vi.fn(),
	createOrder: vi.fn(),
	getOrder: vi.fn(),
	captureOrder: vi.fn(),
	verifyWebhook: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
	auth: { api: { getSession: mocks.getSession } },
}));
vi.mock("@/lib/database", () => ({
	database: { query: mocks.query, connect: mocks.connect },
}));
vi.mock("@app/auth-sdk/paypal", () => ({ createPayPalClient: () => mocks }));

const id = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
let payment: {
	id: string;
	user_id: string;
	amount: string;
	currency: string;
	status: string;
	environment: "sandbox" | "live";
	paypal_order_id: string | null;
	paypal_capture_id: string | null;
	capture_request_id: string;
};
let duplicate = false;

function request(
	path = "capture",
	body: unknown = { paymentId: id },
	origin = "https://example.com",
) {
	return new Request(`https://example.com/api/paypal/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", origin },
		body: JSON.stringify(body),
	});
}

function order(status = "APPROVED", captureStatus?: string): PayPalOrder {
	return {
		id: "ORDER123",
		status,
		purchase_units: [
			{
				reference_id: id,
				custom_id: id,
				amount: { currency_code: "USD", value: "10.00" },
				payments: {
					captures: captureStatus
						? [
								{
									id: "CAPTURE123",
									status: captureStatus,
									amount: { currency_code: "USD", value: "10.00" },
								},
							]
						: [],
				},
			},
		],
		links: [
			{
				rel: "payer-action",
				href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
			},
		],
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("BETTER_AUTH_URL", "https://example.com");
	vi.stubEnv("PAYPAL_CLIENT_ID", "client");
	vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
	vi.stubEnv("PAYPAL_WEBHOOK_ID", "hook");
	vi.stubEnv("PAYPAL_ENVIRONMENT", "sandbox");
	duplicate = false;
	payment = {
		id,
		user_id: "user-1",
		amount: "10.00",
		currency: "USD",
		status: "created",
		environment: "sandbox",
		paypal_order_id: "ORDER123",
		paypal_capture_id: null,
		capture_request_id: requestId,
	};
	mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
	mocks.connect.mockResolvedValue({
		query: mocks.query,
		release: mocks.release,
	});
	mocks.query.mockImplementation(
		async (sql: string, params: unknown[] = []) => {
			if (sql.startsWith("SELECT id FROM paypal_webhook_event"))
				return { rows: duplicate ? [{ id: "EVENT123" }] : [] };
			if (sql.startsWith("SELECT id FROM paypal_payment"))
				return {
					rows:
						payment.status === "paid" &&
						params[0] === payment.user_id &&
						params[2] === payment.environment
							? [{ id }]
							: [],
				};
			if (sql.startsWith("SELECT * FROM paypal_payment WHERE id"))
				return {
					rows:
						params[0] === payment.id &&
						params[1] === payment.user_id &&
						params[2] === payment.environment
							? [{ ...payment }]
							: [],
				};
			if (sql.startsWith("SELECT * FROM paypal_payment WHERE (paypal_order_id"))
				return {
					rows:
						(params[0] === payment.paypal_order_id ||
							params[1] === payment.paypal_capture_id) &&
						params[2] === payment.environment
							? [{ ...payment }]
							: [],
				};
			if (sql.startsWith("UPDATE paypal_payment SET status")) {
				payment.status = String(params[1]);
				payment.paypal_capture_id =
					typeof params[2] === "string" ? params[2] : payment.paypal_capture_id;
				return { rows: [{ ...payment }] };
			}
			if (sql.startsWith("UPDATE paypal_payment SET paypal_order_id"))
				payment.paypal_order_id = String(params[1]);
			if (sql.startsWith("INSERT INTO paypal_webhook_event")) duplicate = true;
			return { rows: [] };
		},
	);
	mocks.getOrder.mockResolvedValue(order());
	mocks.createOrder.mockResolvedValue(order("CREATED"));
	mocks.captureOrder.mockResolvedValue(order("COMPLETED", "COMPLETED"));
	mocks.verifyWebhook.mockResolvedValue({
		id: "EVENT123",
		event_type: "PAYMENT.CAPTURE.COMPLETED",
		resource: {
			id: "CAPTURE123",
			supplementary_data: { related_ids: { order_id: "ORDER123" } },
		},
	});
});

/** @see https://developer.paypal.com/docs/checkout/standard/integrate/ */
describe("PayPal example payment ownership and capture", () => {
	it("rejects anonymous callers before database or gateway access", async () => {
		mocks.getSession.mockResolvedValue(null);
		expect((await createPayment(request("orders"))).status).toBe(401);
		expect((await capturePayment(request())).status).toBe(401);
		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.captureOrder).not.toHaveBeenCalled();
	});
	it("rejects cross-origin payment mutations", async () => {
		expect(
			(
				await createPayment(
					request("orders", { paymentId: id }, "https://attacker.example"),
				)
			).status,
		).toBe(403);
		expect(
			(
				await capturePayment(
					request("capture", { paymentId: id }, "https://attacker.example"),
				)
			).status,
		).toBe(403);
		expect(mocks.query).not.toHaveBeenCalled();
	});
	it("uses the server price and persists the same request ID for retries", async () => {
		payment.paypal_order_id = null;
		const response = await createPayment(
			request("orders", { paymentId: id, amount: "0.01", currency: "CNY" }),
		);
		expect(response.status).toBe(200);
		expect(mocks.createOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: id,
				referenceId: id,
				amount: { currency_code: "USD", value: "10.00" },
				returnURL: `https://example.com/paypal?payment=${id}`,
			}),
		);
		expect(mocks.query).toHaveBeenCalledWith(
			expect.stringContaining("INSERT INTO paypal_payment"),
			expect.arrayContaining([id, "user-1", "digital-access", "10.00", "USD"]),
		);
		await createPayment(request("orders"));
		expect(mocks.createOrder).toHaveBeenCalledTimes(1);
	});
	it("cannot capture another user's order", async () => {
		payment.user_id = "other-user";
		expect((await capturePayment(request())).status).toBe(404);
		expect(mocks.getOrder).not.toHaveBeenCalled();
		expect(mocks.captureOrder).not.toHaveBeenCalled();
	});
	it("never grants live access for a sandbox payment", async () => {
		payment.status = "paid";
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		expect(
			(await paidAccess(new Request("https://example.com/api/paypal/access")))
				.status,
		).toBe(403);
		expect(mocks.query).toHaveBeenCalledWith(
			expect.stringContaining("environment = $3"),
			["user-1", "digital-access", "live"],
		);
	});
	it("cannot reuse or capture a payment ID from another environment", async () => {
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		expect((await createPayment(request("orders"))).status).toBe(404);
		expect((await capturePayment(request())).status).toBe(404);
		expect(mocks.query).toHaveBeenCalledWith(
			expect.stringContaining("environment = $3 FOR UPDATE"),
			[id, "user-1", "live"],
		);
		expect(mocks.createOrder).not.toHaveBeenCalled();
		expect(mocks.getOrder).not.toHaveBeenCalled();
		expect(mocks.captureOrder).not.toHaveBeenCalled();
	});
	it("normalizes UUID case before binding the local and remote payment", async () => {
		const normalized = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		payment.id = normalized;
		payment.paypal_order_id = null;
		const response = order("CREATED");
		response.purchase_units![0]!.custom_id = normalized;
		response.purchase_units![0]!.reference_id = normalized;
		mocks.createOrder.mockResolvedValue(response);
		mocks.getOrder.mockResolvedValue(response);
		expect(
			(
				await createPayment(
					request("orders", { paymentId: normalized.toUpperCase() }),
				)
			).status,
		).toBe(200);
		expect(mocks.createOrder).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: normalized,
				referenceId: normalized,
			}),
		);
	});
	it("rejects an approval redirect outside PayPal", async () => {
		const response = order("CREATED");
		response.links = [
			{ rel: "payer-action", href: "https://attacker.example/checkout" },
		];
		mocks.getOrder.mockResolvedValue(response);
		expect((await createPayment(request("orders"))).status).toBe(503);
	});
	it("captures only approved matching orders, using the durable capture request ID", async () => {
		mocks.getOrder
			.mockResolvedValueOnce(order())
			.mockResolvedValue(order("COMPLETED", "COMPLETED"));
		// PayPal 捕获响应可以省略 custom_id 与订单金额，必须重新读取订单。
		mocks.captureOrder.mockResolvedValue({
			id: "ORDER123",
			status: "COMPLETED",
		});
		expect((await capturePayment(request())).status).toBe(200);
		expect(mocks.captureOrder).toHaveBeenCalledWith({
			orderId: "ORDER123",
			requestId,
		});
		expect(payment.status).toBe("paid");
		expect(
			(await paidAccess(new Request("https://example.com/api/paypal/access")))
				.status,
		).toBe(200);
	});
	it("does not capture again after a successful capture whose response was lost", async () => {
		mocks.getOrder.mockResolvedValue(order("COMPLETED", "COMPLETED"));
		expect((await capturePayment(request())).status).toBe(200);
		expect(mocks.captureOrder).not.toHaveBeenCalled();
		expect(payment.status).toBe("paid");
	});
	it.each([
		"PENDING",
		"DECLINED",
		"REFUNDED",
		"PARTIALLY_REFUNDED",
	])("never grants access for capture status %s", async (status) => {
		mocks.getOrder.mockResolvedValue(order("COMPLETED", status));
		await capturePayment(request());
		expect(payment.status).not.toBe("paid");
		expect(
			(await paidAccess(new Request("https://example.com/api/paypal/access")))
				.status,
		).toBe(403);
		expect(mocks.captureOrder).not.toHaveBeenCalled();
	});
	it("marks a voided order as denied so the customer can start another checkout", async () => {
		mocks.getOrder.mockResolvedValue(order("VOIDED"));
		const response = await capturePayment(request());
		expect(await response.json()).toEqual({ paymentId: id, status: "denied" });
		expect(mocks.captureOrder).not.toHaveBeenCalled();
	});
	it.each([
		"amount",
		"currency",
		"reference",
		"captureAmount",
	])("rejects a mismatched %s before granting access", async (field) => {
		const response = order("COMPLETED", "COMPLETED");
		const unit = response.purchase_units![0]!;
		if (field === "amount") unit.amount!.value = "1.00";
		if (field === "currency") unit.amount!.currency_code = "EUR";
		if (field === "reference") unit.custom_id = "foreign-payment";
		if (field === "captureAmount")
			unit.payments!.captures![0]!.amount.value = "1.00";
		mocks.getOrder.mockResolvedValue(response);
		expect((await capturePayment(request())).status).toBe(503);
		expect(payment.status).toBe("created");
		expect(mocks.captureOrder).not.toHaveBeenCalled();
	});
});

/** @see https://developer.paypal.com/api/rest/webhooks/ */
describe("PayPal example verified webhook synchronization", () => {
	it("rejects invalid signatures before database access", async () => {
		mocks.verifyWebhook.mockRejectedValue(
			Object.assign(new Error("Invalid"), { name: "PayPalWebhookError" }),
		);
		expect((await receiveWebhook(request("webhook"))).status).toBe(400);
		expect(mocks.query).not.toHaveBeenCalled();
	});
	it("returns a retryable error when signature verification is unavailable", async () => {
		mocks.verifyWebhook.mockRejectedValue(new Error("Network unavailable"));
		expect((await receiveWebhook(request("webhook"))).status).toBe(503);
		expect(mocks.query).not.toHaveBeenCalled();
	});
	it("fetches authoritative state and processes duplicate events once", async () => {
		mocks.getOrder.mockResolvedValue(order("COMPLETED", "COMPLETED"));
		expect((await receiveWebhook(request("webhook"))).status).toBe(200);
		expect((await receiveWebhook(request("webhook"))).status).toBe(200);
		expect(mocks.verifyWebhook).toHaveBeenCalledTimes(2);
		expect(mocks.getOrder).toHaveBeenCalledTimes(1);
		expect(payment.status).toBe("paid");
	});
	it("does not trust a completed event when authoritative capture is pending", async () => {
		mocks.getOrder.mockResolvedValue(order("COMPLETED", "PENDING"));
		await receiveWebhook(request("webhook"));
		expect(payment.status).toBe("pending");
	});
	it("finds refunds through their parent capture and revokes access", async () => {
		payment.status = "paid";
		payment.paypal_capture_id = "CAPTURE123";
		mocks.getOrder.mockResolvedValue(order("COMPLETED", "COMPLETED"));
		mocks.verifyWebhook.mockResolvedValue({
			id: "REFUND_EVENT",
			event_type: "PAYMENT.CAPTURE.REFUNDED",
			resource: {
				id: "REFUND123",
				links: [
					{
						rel: "up",
						href: "https://api.paypal.com/v2/payments/captures/CAPTURE123",
					},
				],
			},
		});
		expect((await receiveWebhook(request("webhook"))).status).toBe(200);
		expect(payment.status).toBe("refunded");
		expect(
			(await paidAccess(new Request("https://example.com/api/paypal/access")))
				.status,
		).toBe(403);
	});
	it.each([
		"refunded",
		"reversed",
		"denied",
	])("cannot re-enable a %s payment with a delayed completion event", async (status) => {
		payment.status = status;
		mocks.getOrder.mockResolvedValue(order("COMPLETED", "COMPLETED"));
		await receiveWebhook(request("webhook"));
		expect(payment.status).toBe(status);
	});
	it("does not acknowledge a known event before the local order is available", async () => {
		payment.paypal_order_id = "DIFFERENT";
		expect((await receiveWebhook(request("webhook"))).status).toBe(503);
		expect(duplicate).toBe(false);
	});
	it("does not reconcile a webhook into a payment from another environment", async () => {
		vi.stubEnv("PAYPAL_ENVIRONMENT", "live");
		expect((await receiveWebhook(request("webhook"))).status).toBe(503);
		expect(mocks.getOrder).not.toHaveBeenCalled();
		expect(duplicate).toBe(false);
	});
});
