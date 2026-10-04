import type { PayPalOrder } from "@app/auth-sdk/paypal";
import { createPayPalClient } from "@app/auth-sdk/paypal";
import { appendQueryParams } from "@better-auth/core/utils/url";
import type { PoolClient } from "pg";
import { auth } from "@/lib/auth";
import { database } from "@/lib/database";
import { requiredEnv } from "@/lib/env";

// 价格只在服务端定义。修改商品时保留已创建订单的金额快照。
const product = { id: "digital-access", amount: "10.00", currency: "USD" };
const uuid =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Payment = {
	id: string;
	user_id: string;
	environment: "sandbox" | "live";
	amount: string;
	currency: string;
	status: string;
	paypal_order_id: string | null;
	paypal_capture_id: string | null;
	capture_request_id: string;
};

function paypalEnvironment() {
	const environment = process.env.PAYPAL_ENVIRONMENT ?? "sandbox";
	if (environment !== "sandbox" && environment !== "live") {
		throw new Error("PAYPAL_ENVIRONMENT 必须是 sandbox 或 live");
	}
	return environment;
}

function paypal() {
	return createPayPalClient({
		clientId: requiredEnv("PAYPAL_CLIENT_ID"),
		clientSecret: requiredEnv("PAYPAL_CLIENT_SECRET"),
		webhookId: requiredEnv("PAYPAL_WEBHOOK_ID"),
		environment: paypalEnvironment(),
	});
}

function fail(status: number, error: string): never {
	throw Response.json({ error }, { status });
}

async function user(request: Request, mutate = false) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) fail(401, "请先登录");
	if (mutate) {
		const origin = new URL(requiredEnv("BETTER_AUTH_URL")).origin;
		if (request.headers.get("origin") !== origin) fail(403, "请求来源无效");
		if (
			request.headers.get("content-type")?.split(";")[0] !== "application/json"
		) {
			fail(415, "请使用 JSON 请求");
		}
	}
	return session.user.id;
}

async function paymentId(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		fail(400, "请求内容无效");
	}
	if (
		!body ||
		typeof body !== "object" ||
		!("paymentId" in body) ||
		typeof body.paymentId !== "string" ||
		!uuid.test(body.paymentId)
	) {
		fail(400, "paymentId 必须是 UUID v4");
	}
	return body.paymentId.toLowerCase();
}

async function transaction<T>(action: (client: PoolClient) => Promise<T>) {
	const client = await database.connect();
	try {
		await client.query("BEGIN");
		const result = await action(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

function handleError(error: unknown) {
	if (error instanceof Response) return error;
	// 网关、网络与数据库故障返回可重试状态，不暴露密钥或上游响应。
	return Response.json(
		{ error: "支付服务暂时不可用，请使用同一订单重试。" },
		{ status: 503 },
	);
}

function cents(value: string) {
	if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("Invalid amount");
	const [integer, decimal = ""] = value.split(".");
	return BigInt(integer!) * 100n + BigInt(decimal.padEnd(2, "0"));
}

function checkOrder(order: PayPalOrder, payment: Payment) {
	const unit = order.purchase_units?.[0];
	if (
		order.id !== payment.paypal_order_id ||
		order.purchase_units?.length !== 1 ||
		unit?.custom_id !== payment.id ||
		unit.reference_id !== payment.id ||
		unit.amount?.currency_code !== payment.currency ||
		cents(unit.amount.value) !== cents(payment.amount)
	) {
		throw new Error("PayPal order does not match local payment");
	}
	return unit;
}

async function synchronize(
	client: PoolClient,
	payment: Payment,
	order: PayPalOrder,
	eventType = "",
) {
	const unit = checkOrder(order, payment);
	const captures = unit.payments?.captures ?? [];
	if (captures.length > 1) throw new Error("Unexpected multiple captures");
	const capture = captures[0];
	if (
		capture &&
		(capture.amount.currency_code !== payment.currency ||
			cents(capture.amount.value) !== cents(payment.amount))
	) {
		throw new Error("PayPal capture amount does not match local payment");
	}
	let status = "pending";
	if (eventType === "PAYMENT.CAPTURE.REVERSED") status = "reversed";
	else if (
		eventType === "PAYMENT.CAPTURE.REFUNDED" ||
		capture?.status === "REFUNDED" ||
		capture?.status === "PARTIALLY_REFUNDED"
	)
		status = "refunded";
	else if (
		["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"].includes(
			eventType,
		) ||
		order.status === "VOIDED" ||
		["DECLINED", "DENIED", "FAILED"].includes(capture?.status ?? "")
	)
		status = "denied";
	else if (order.status === "COMPLETED" && capture?.status === "COMPLETED")
		status = "paid";
	// 退款和撤销是终态；延迟或重复的完成通知不能重新授予权限。
	if (["refunded", "reversed", "denied"].includes(payment.status))
		status = payment.status;
	const result = await client.query<Payment>(
		`UPDATE paypal_payment SET status = $2, paypal_capture_id = COALESCE($3, paypal_capture_id),
		 updated_at = now() WHERE id = $1 RETURNING *`,
		[payment.id, status, capture?.id ?? null],
	);
	return result.rows[0]!;
}

/** 创建属于当前用户的固定价格订单；同一 paymentId 可安全重试。 */
export async function createPayment(request: Request) {
	try {
		const userId = await user(request, true);
		const id = await paymentId(request);
		const environment = paypalEnvironment();
		// 先持久化重试键和金额；即使后面的远程请求失败也不能丢失。
		await database.query(
			`INSERT INTO paypal_payment (id, user_id, product_id, amount, currency, capture_request_id, environment)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
			[
				id,
				userId,
				product.id,
				product.amount,
				product.currency,
				crypto.randomUUID(),
				environment,
			],
		);
		return await transaction(async (client) => {
			const {
				rows: [payment],
			} = await client.query<Payment>(
				"SELECT * FROM paypal_payment WHERE id = $1 AND user_id = $2 AND environment = $3 FOR UPDATE",
				[id, userId, environment],
			);
			if (!payment) fail(404, "订单不存在");
			const api = paypal();
			const returnURL = appendQueryParams(
				new URL("/paypal", requiredEnv("BETTER_AUTH_URL")).href,
				new URLSearchParams({ payment: id }),
			);
			const cancelURL = appendQueryParams(
				returnURL,
				new URLSearchParams({ cancelled: "1" }),
			);
			// ponytail: 每个订单在远程请求期间持有行锁；高吞吐量场景改用持久化任务队列。
			const created = payment.paypal_order_id
				? await api.getOrder(payment.paypal_order_id)
				: await api.createOrder({
						requestId: id,
						referenceId: id,
						amount: { currency_code: payment.currency, value: payment.amount },
						returnURL,
						cancelURL,
						description: "Digital access — one-time payment",
					});
			// 创建/捕获接口允许返回精简表示；读取订单详情再检查绑定信息。
			const order = payment.paypal_order_id
				? created
				: await api.getOrder(created.id);
			const approvalURL = created.links?.find(
				(link) => link.rel === "payer-action" || link.rel === "approve",
			)?.href;
			if (approvalURL) {
				const url = new URL(approvalURL);
				if (
					url.protocol !== "https:" ||
					url.username ||
					url.password ||
					url.port ||
					!["www.paypal.com", "www.sandbox.paypal.com"].includes(url.hostname)
				) {
					throw new Error("Untrusted PayPal approval URL");
				}
			}
			payment.paypal_order_id = order.id;
			checkOrder(order, payment);
			await client.query(
				"UPDATE paypal_payment SET paypal_order_id = $2, updated_at = now() WHERE id = $1",
				[id, order.id],
			);
			return Response.json({
				paymentId: id,
				approvalURL,
				status: payment.status,
			});
		});
	} catch (error) {
		return handleError(error);
	}
}

/** 用户在 PayPal 批准后通过 POST 确认；回跳参数从不决定付费权限。 */
export async function capturePayment(request: Request) {
	try {
		const userId = await user(request, true);
		const id = await paymentId(request);
		const environment = paypalEnvironment();
		return await transaction(async (client) => {
			const {
				rows: [payment],
			} = await client.query<Payment>(
				"SELECT * FROM paypal_payment WHERE id = $1 AND user_id = $2 AND environment = $3 FOR UPDATE",
				[id, userId, environment],
			);
			if (!payment?.paypal_order_id) fail(404, "订单不存在");
			const api = paypal();
			let order = await api.getOrder(payment.paypal_order_id);
			const unit = checkOrder(order, payment);
			if (
				order.status === "APPROVED" &&
				!unit.payments?.captures?.length &&
				!["paid", "refunded", "reversed", "denied"].includes(payment.status)
			) {
				await api.captureOrder({
					orderId: payment.paypal_order_id,
					requestId: payment.capture_request_id,
				});
				order = await api.getOrder(payment.paypal_order_id);
			}
			const updated = await synchronize(client, payment, order);
			return Response.json({ paymentId: id, status: updated.status });
		});
	} catch (error) {
		return handleError(error);
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function eventIds(resource: Record<string, unknown>) {
	const related = record(record(resource.supplementary_data).related_ids);
	const orderId =
		typeof related.order_id === "string" ? related.order_id : null;
	let captureId =
		typeof related.capture_id === "string" ? related.capture_id : null;
	// 退款资源的 id 是退款 ID；up 链接指向其所属 capture。
	for (const link of Array.isArray(resource.links) ? resource.links : []) {
		const candidate = record(link);
		if (candidate.rel !== "up" || typeof candidate.href !== "string") continue;
		const url = new URL(candidate.href);
		if (
			url.protocol === "https:" &&
			[
				"api.paypal.com",
				"api-m.paypal.com",
				"api.sandbox.paypal.com",
				"api-m.sandbox.paypal.com",
			].includes(url.hostname)
		) {
			captureId ??=
				/^\/v2\/payments\/captures\/([A-Za-z0-9]+)$/.exec(url.pathname)?.[1] ??
				null;
		}
	}
	return {
		orderId,
		captureId:
			captureId ?? (typeof resource.id === "string" ? resource.id : null),
	};
}

/** 先验签，再查询 PayPal 的权威订单状态；事件和订单变更在同一事务中提交。 */
export async function receiveWebhook(request: Request) {
	try {
		const api = paypal();
		const event = await api.verifyWebhook({
			headers: request.headers,
			body: await request.text(),
		});
		if (
			![
				"PAYMENT.CAPTURE.COMPLETED",
				"PAYMENT.CAPTURE.PENDING",
				"PAYMENT.CAPTURE.DENIED",
				"PAYMENT.CAPTURE.DECLINED",
				"PAYMENT.CAPTURE.REFUNDED",
				"PAYMENT.CAPTURE.REVERSED",
			].includes(event.event_type)
		) {
			return Response.json({ received: true });
		}
		const { orderId, captureId } = eventIds(event.resource);
		const environment = paypalEnvironment();
		return await transaction(async (client) => {
			const duplicate = await client.query(
				"SELECT id FROM paypal_webhook_event WHERE id = $1 AND environment = $2",
				[event.id, environment],
			);
			if (duplicate.rows.length) return Response.json({ received: true });
			const {
				rows: [payment],
			} = await client.query<Payment>(
				"SELECT * FROM paypal_payment WHERE (paypal_order_id = $1 OR paypal_capture_id = $2) AND environment = $3 FOR UPDATE",
				[orderId, captureId, environment],
			);
			if (!payment?.paypal_order_id) fail(503, "订单尚未同步，请重试");
			const order = await api.getOrder(payment.paypal_order_id);
			await synchronize(client, payment, order, event.event_type);
			await client.query(
				"INSERT INTO paypal_webhook_event (id, payment_id, environment) VALUES ($1, $2, $3) ON CONFLICT (environment, id) DO NOTHING",
				[event.id, payment.id, environment],
			);
			return Response.json({ received: true });
		});
	} catch (error) {
		if (error instanceof Error && error.name === "PayPalWebhookError") {
			return Response.json({ error: "Webhook 验证失败" }, { status: 400 });
		}
		return handleError(error);
	}
}

/** 业务接口只检查登录用户在数据库中已核实的付款。 */
export async function paidAccess(request: Request) {
	try {
		const userId = await user(request);
		const { rows } = await database.query(
			"SELECT id FROM paypal_payment WHERE user_id = $1 AND product_id = $2 AND environment = $3 AND status = 'paid' LIMIT 1",
			[userId, product.id, paypalEnvironment()],
		);
		if (!rows.length) fail(403, "需要已完成的付款");
		return Response.json({ message: "可以在这里执行已经付款的业务操作。" });
	} catch (error) {
		return handleError(error);
	}
}
