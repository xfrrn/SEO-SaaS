/** Server-only credentials for PayPal global checkout, including PayPal.cn merchants. */
export interface PayPalOptions {
	clientId: string;
	clientSecret: string;
	webhookId: string;
	/** Defaults to sandbox. Live credentials must be configured separately. */
	environment?: "sandbox" | "live";
}

/** Decimal strings avoid floating-point rounding of payment amounts. */
export interface PayPalAmount {
	currency_code: string;
	value: string;
}

/** Fields used to reconcile a single, immediately captured PayPal order. */
export interface PayPalOrder {
	id: string;
	status: string;
	links?: { rel: string; href: string; method?: string }[];
	purchase_units?: {
		reference_id?: string;
		custom_id?: string;
		amount?: PayPalAmount;
		payments?: {
			captures?: { id: string; status: string; amount: PayPalAmount }[];
		};
	}[];
}

/** A verified delivery; applications must still reconcile and deduplicate fulfillment. */
export interface PayPalWebhookEvent {
	id: string;
	event_type: string;
	resource: Record<string, unknown>;
}

/** Use server-owned prices and a persisted request ID when retrying checkout. */
export interface PayPalCreateOrder {
	requestId: string;
	referenceId: string;
	amount: PayPalAmount;
	returnURL: string;
	cancelURL: string;
	description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAmount(value: unknown): value is PayPalAmount {
	return (
		isRecord(value) &&
		typeof value.currency_code === "string" &&
		/^[A-Z]{3}$/.test(value.currency_code) &&
		typeof value.value === "string" &&
		/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value.value) &&
		/[1-9]/.test(value.value) &&
		(!["JPY", "HUF", "TWD"].includes(value.currency_code) ||
			!value.value.includes("."))
	);
}

function isOrder(value: unknown): value is PayPalOrder {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		/^[A-Za-z0-9]{1,64}$/.test(value.id) &&
		typeof value.status === "string" &&
		(value.links === undefined ||
			(Array.isArray(value.links) &&
				value.links.every(
					(link) =>
						isRecord(link) &&
						typeof link.rel === "string" &&
						typeof link.href === "string" &&
						(link.method === undefined || typeof link.method === "string"),
				))) &&
		(value.purchase_units === undefined ||
			(Array.isArray(value.purchase_units) &&
				value.purchase_units.every(
					(unit) =>
						isRecord(unit) &&
						(unit.reference_id === undefined ||
							typeof unit.reference_id === "string") &&
						(unit.custom_id === undefined ||
							typeof unit.custom_id === "string") &&
						(unit.amount === undefined || isAmount(unit.amount)) &&
						(unit.payments === undefined ||
							(isRecord(unit.payments) &&
								(unit.payments.captures === undefined ||
									(Array.isArray(unit.payments.captures) &&
										unit.payments.captures.every(
											(capture) =>
												isRecord(capture) &&
												typeof capture.id === "string" &&
												typeof capture.status === "string" &&
												isAmount(capture.amount),
										))))),
				)))
	);
}

function validateRequestId(id: string) {
	if (!/^[A-Za-z0-9_-]{1,108}$/.test(id)) {
		throw new Error("Invalid PayPal request ID");
	}
}

function orderPath(id: string) {
	if (!/^[A-Za-z0-9]{1,64}$/.test(id)) {
		throw new Error("Invalid PayPal order ID");
	}
	return `/v2/checkout/orders/${id}`;
}

function validateReturnURL(value: string) {
	const url = new URL(value);
	if (
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && url.hostname === "localhost")) ||
		url.username ||
		url.password
	) {
		throw new Error(
			"PayPal return URLs require HTTPS (or localhost for testing)",
		);
	}
}

function webhookError() {
	return Object.assign(new Error("Invalid PayPal webhook signature or event"), {
		name: "PayPalWebhookError",
	});
}

/**
 * Create a server-only PayPal Orders v2 client using standard Web APIs.
 * This is a payment helper, not a Better Auth plugin. Authorization, persistence
 * and fulfillment belong to the application.
 */
export function createPayPalClient(options: PayPalOptions) {
	const environment = options.environment ?? "sandbox";
	if (environment !== "sandbox" && environment !== "live") {
		throw new Error("Invalid PayPal environment");
	}
	if (
		!options.clientId?.trim() ||
		!options.clientSecret?.trim() ||
		!options.webhookId?.trim()
	) {
		throw new Error("PayPal clientId, clientSecret and webhookId are required");
	}
	const origin =
		environment === "live"
			? "https://api-m.paypal.com"
			: "https://api-m.sandbox.paypal.com";

	async function readResponse(response: Response): Promise<unknown> {
		if (!response.ok) {
			// Do not expose upstream bodies, credentials or customer information.
			const debugId = response.headers.get("paypal-debug-id");
			const debug =
				debugId && /^[A-Za-z0-9_-]{1,128}$/.test(debugId)
					? `, debug ID: ${debugId}`
					: "";
			throw new Error(`PayPal request failed (${response.status}${debug})`);
		}
		return response.json();
	}

	async function request(path: string, body?: unknown, requestId?: string) {
		const token = await readResponse(
			await fetch(`${origin}/v1/oauth2/token`, {
				method: "POST",
				headers: {
					Authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: "grant_type=client_credentials",
				cache: "no-store",
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			}),
		);
		if (
			!isRecord(token) ||
			typeof token.access_token !== "string" ||
			!token.access_token
		) {
			throw new Error("Invalid PayPal access token response");
		}
		return readResponse(
			await fetch(`${origin}${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token.access_token}`,
					"Content-Type": "application/json",
					Prefer: "return=representation",
					...(requestId ? { "PayPal-Request-Id": requestId } : {}),
				},
				body:
					body === undefined
						? undefined
						: typeof body === "string"
							? body
							: JSON.stringify(body),
				cache: "no-store",
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			}),
		);
	}

	async function orderRequest(
		path: string,
		body?: unknown,
		requestId?: string,
	) {
		const order = await request(path, body, requestId);
		if (!isOrder(order)) {
			throw new Error("Invalid PayPal order response");
		}
		return order;
	}

	return {
		/** Create a single-unit, no-shipping checkout with a server-owned amount. */
		async createOrder(input: PayPalCreateOrder): Promise<PayPalOrder> {
			validateRequestId(input.requestId);
			if (!input.referenceId?.trim() || input.referenceId.length > 127) {
				throw new Error("Invalid PayPal reference ID");
			}
			if (!isAmount(input.amount)) {
				throw new Error("Invalid PayPal amount");
			}
			validateReturnURL(input.returnURL);
			validateReturnURL(input.cancelURL);
			return orderRequest(
				"/v2/checkout/orders",
				{
					intent: "CAPTURE",
					purchase_units: [
						{
							reference_id: input.referenceId,
							custom_id: input.referenceId,
							amount: input.amount,
							description: input.description,
						},
					],
					payment_source: {
						paypal: {
							experience_context: {
								return_url: input.returnURL,
								cancel_url: input.cancelURL,
								shipping_preference: "NO_SHIPPING",
								user_action: "PAY_NOW",
							},
						},
					},
				},
				input.requestId,
			);
		},
		/** Look up authoritative state before reconciling local payment records. */
		async getOrder(orderId: string): Promise<PayPalOrder> {
			return orderRequest(orderPath(orderId));
		},
		/** Capture only an owned order; reuse its persisted capture request ID on retry. */
		async captureOrder(input: {
			orderId: string;
			requestId: string;
		}): Promise<PayPalOrder> {
			validateRequestId(input.requestId);
			return orderRequest(
				`${orderPath(input.orderId)}/capture`,
				{},
				input.requestId,
			);
		},
		/** Verify through PayPal before trusting a delivery; API failures must be retried. */
		async verifyWebhook(input: {
			headers: Headers;
			body: string;
		}): Promise<PayPalWebhookEvent> {
			const fields = {
				auth_algo: input.headers.get("paypal-auth-algo"),
				cert_url: input.headers.get("paypal-cert-url"),
				transmission_id: input.headers.get("paypal-transmission-id"),
				transmission_sig: input.headers.get("paypal-transmission-sig"),
				transmission_time: input.headers.get("paypal-transmission-time"),
			};
			if (Object.values(fields).some((value) => !value?.trim())) {
				throw webhookError();
			}
			let event: unknown;
			try {
				event = JSON.parse(input.body);
			} catch {
				throw webhookError();
			}
			if (
				!isRecord(event) ||
				typeof event.id !== "string" ||
				!event.id ||
				typeof event.event_type !== "string" ||
				!event.event_type ||
				!isRecord(event.resource)
			) {
				throw webhookError();
			}
			const verification = JSON.stringify({
				...fields,
				webhook_id: options.webhookId,
			});
			// PayPal verifies the original event representation, including whitespace
			// and numeric/string escapes. Never re-serialize the parsed event here.
			const result = await request(
				"/v1/notifications/verify-webhook-signature",
				`${verification.slice(0, -1)},"webhook_event":${input.body}}`,
			);
			if (!isRecord(result) || result.verification_status !== "SUCCESS") {
				throw webhookError();
			}
			return {
				...event,
				id: event.id,
				event_type: event.event_type,
				resource: event.resource,
			};
		},
	};
}
