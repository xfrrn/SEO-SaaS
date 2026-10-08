import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";

function storedInteger(value: unknown): number | null | undefined {
	if (value === null || value === undefined) return value;
	if (
		(typeof value !== "number" &&
			typeof value !== "string" &&
			typeof value !== "bigint") ||
		(typeof value === "string" && !/^\d+$/.test(value))
	)
		throw new Error("Invalid stored subscription integer");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error("Invalid stored subscription integer");
	return parsed;
}

const integer = {
	type: "number",
	bigint: true,
	transform: { output: storedInteger },
} as const;

/** Create fresh shared fields so provider-specific schema mappings cannot leak. */
export function createSubscriptionSchema() {
	return {
		subscription: {
			fields: {
				plan: { type: "string", required: true },
				referenceId: { type: "string", required: true },
				status: { type: "string", defaultValue: "incomplete" },
				periodStart: { type: "date", required: false },
				periodEnd: { type: "date", required: false },
				trialStart: { type: "date", required: false },
				trialEnd: { type: "date", required: false },
				cancelAtPeriodEnd: {
					type: "boolean",
					required: false,
					defaultValue: false,
				},
				cancelAt: { type: "date", required: false },
				canceledAt: { type: "date", required: false },
				endedAt: { type: "date", required: false },
				seats: { type: "number", required: false },
				billingInterval: { type: "string", required: false },
			},
		},
	} satisfies BetterAuthPluginDBSchema;
}

/** Create the shared table with optional provider synchronization metadata. */
export function createProviderSubscriptionSchema() {
	const schema = createSubscriptionSchema();
	return {
		subscription: {
			fields: {
				...schema.subscription.fields,
				provider: { type: "string", required: false },
				providerSubscriptionId: { type: "string", required: false },
				providerCustomerId: { type: "string", required: false },
				revision: { ...integer, required: false },
				syncKey: { type: "string", required: false, unique: true },
			},
		},
	} satisfies BetterAuthPluginDBSchema;
}

/** Catalog versions are append-only so existing orders and memberships keep their terms. */
export function createProductSchema() {
	return {
		subscriptionProduct: {
			fields: {
				key: { type: "string", required: true, index: true },
				version: { ...integer, required: true },
				versionKey: { type: "string", required: true, unique: true },
				name: { type: "string", required: true },
				type: { type: "string", required: true },
				amount: { ...integer, required: true },
				currency: { type: "string", required: true },
				credits: { ...integer, required: true },
				membershipDays: { ...integer, required: false },
				creditValidityDays: { ...integer, required: false },
				limits: {
					type: "json",
					required: true,
					// Entitlement JSON must preserve strings rather than revive ISO dates.
					transform: {
						output: (value: unknown) =>
							typeof value === "string" ? JSON.parse(value) : value,
					},
				},
				published: { type: "boolean", required: true },
				createdAt: { type: "date", required: true },
			},
		},
	} satisfies BetterAuthPluginDBSchema;
}
