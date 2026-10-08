import * as z from "zod";

export const identifier = z.string().trim().min(1).max(128);
export const positiveInteger = z
	.number()
	.int()
	.min(1)
	.max(Number.MAX_SAFE_INTEGER);
export const date = z.union([
	z.date(),
	z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
]);
export const pagination = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER)
		.default(0),
});
export const newOrder = z.object({
	productId: identifier,
	provider: identifier,
	idempotencyKey: identifier,
});
export const paymentConfirmation = z.object({
	orderId: identifier,
	reference: identifier,
});
export const verifiedPayment = z
	.object({
		paymentId: identifier,
		providerOrderId: identifier,
		amount: positiveInteger,
		currency: z.string().regex(/^[A-Z]{3}$/),
		paidAt: date,
		periodStart: date.optional(),
		periodEnd: date.optional(),
	})
	.refine(
		(value) => !!value.periodStart === !!value.periodEnd,
		"Both billing period boundaries are required",
	)
	.refine(
		(value) => !value.periodStart || value.periodStart < value.periodEnd!,
		"Invalid billing period",
	);
export const verifiedRefund = z.object({
	refundId: identifier,
	paymentId: identifier,
	amount: positiveInteger,
	currency: z.string().regex(/^[A-Z]{3}$/),
	refundedAt: date,
});
export const creditAdjustment = z.object({
	operationId: identifier,
	referenceId: identifier,
	action: z.enum(["grant", "consume"]),
	amount: positiveInteger,
	reason: z.string().trim().min(1).max(500),
	expiresAt: date.optional(),
});
export const membershipAdjustment = z
	.object({
		operationId: identifier,
		referenceId: identifier,
		subscriptionId: identifier.optional(),
		productId: identifier,
		expectedRevision: z
			.number()
			.int()
			.min(0)
			.max(Number.MAX_SAFE_INTEGER)
			.optional(),
		status: z.enum(["active", "canceled"]),
		periodStart: date,
		periodEnd: date,
		reason: z.string().trim().min(1).max(500),
	})
	.refine(
		(value) => value.periodStart < value.periodEnd,
		"Invalid membership period",
	);

/** Stable comparison for persisted JSON and repeated, semantically identical requests. */
export function canonicalJSON(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			return Object.fromEntries(
				Object.entries(item).sort(([left], [right]) =>
					left.localeCompare(right),
				),
			);
		}
		return item;
	});
}

/** Unambiguous, bounded keys also fit databases with 255-character string columns. */
export async function compositeKey(...parts: string[]): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(parts)),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
