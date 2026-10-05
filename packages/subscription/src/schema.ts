import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";

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
				revision: { type: "number", required: false },
				syncKey: { type: "string", required: false, unique: true },
			},
		},
	} satisfies BetterAuthPluginDBSchema;
}
