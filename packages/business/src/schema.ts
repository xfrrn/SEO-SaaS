import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";
import { monitorOrderFields, monitorSchema } from "./monitor-schema";

function storedInteger(value: unknown): number {
	if (
		(typeof value !== "number" &&
			typeof value !== "bigint" &&
			typeof value !== "string") ||
		(typeof value === "string" && !/^\d+$/.test(value))
	)
		throw new Error("Invalid stored business amount");
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0)
		throw new Error("Invalid stored business amount");
	return number;
}

/** Local business records; payment-channel tables and auth tables remain owned by their plugins. */
export const businessSchema = {
	...monitorSchema,
	businessOrder: {
		fields: {
			...monitorOrderFields,
			referenceId: { type: "string", required: true, index: true },
			checkoutKey: { type: "string", required: true, unique: true },
			provider: { type: "string", required: true },
			productId: { type: "string", required: true },
			productKey: { type: "string", required: true, index: true },
			parentOrderId: { type: "string", required: false },
			product: {
				type: "json",
				required: true,
				// Preserve the JSON snapshot without the adapter's automatic ISO-date revival.
				transform: {
					output: (value: unknown) =>
						typeof value === "string" ? JSON.parse(value) : value,
				},
			},
			amount: {
				type: "number",
				bigint: true,
				required: true,
				transform: { output: storedInteger },
			},
			currency: { type: "string", required: true },
			status: { type: "string", required: true },
			providerOrderId: { type: "string", required: false },
			providerKey: { type: "string", required: false, unique: true },
			checkoutURL: { type: "string", required: false },
			paymentId: { type: "string", required: false },
			paidAt: { type: "date", required: false },
			periodStart: { type: "date", required: false },
			periodEnd: { type: "date", required: false },
			refundedAmount: {
				type: "number",
				bigint: true,
				required: true,
				transform: { output: storedInteger },
			},
			reviewRequired: { type: "boolean", required: true },
			createdAt: { type: "date", required: true },
			expiresAt: { type: "date", required: true },
			fulfilledAt: { type: "date", required: false },
		},
	},
	businessPaymentEvent: {
		fields: {
			eventKey: { type: "string", required: true, unique: true },
			orderId: { type: "string", required: true, index: true },
			kind: { type: "string", required: true },
			payload: { type: "json", required: true },
			createdAt: { type: "date", required: true },
		},
	},
	businessCustomer: {
		fields: {
			referenceId: { type: "string", required: true, unique: true },
			updatedAt: { type: "date", required: true },
			lastPaidAt: { type: "date", required: false, index: true },
		},
	},
	businessAction: {
		fields: {
			actionKey: { type: "string", required: true, unique: true },
			actorId: { type: "string", required: true },
			payload: { type: "json", required: true },
			result: { type: "json", required: false },
			createdAt: { type: "date", required: true },
		},
	},
} satisfies BetterAuthPluginDBSchema;
