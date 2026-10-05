import { createSubscriptionSchema } from "@app/subscription/schema";
import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";
import { mergeSchema } from "better-auth/db";
import type { StripeOptions } from "./types";

const createStripeSubscriptionSchema = () => {
	const common = createSubscriptionSchema();
	return {
		subscription: {
			...common.subscription,
			fields: {
				...common.subscription.fields,
				stripeCustomerId: { type: "string", required: false },
				stripeSubscriptionId: { type: "string", required: false },
				stripeScheduleId: { type: "string", required: false },
			},
		},
	} satisfies BetterAuthPluginDBSchema;
};

export const subscriptions = createStripeSubscriptionSchema();

export const user = {
	user: {
		fields: {
			stripeCustomerId: {
				type: "string",
				required: false,
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

export const organization = {
	organization: {
		fields: {
			stripeCustomerId: {
				type: "string",
				required: false,
			},
		},
	},
} satisfies BetterAuthPluginDBSchema;

type GetSchemaResult<O extends StripeOptions> = typeof user &
	(O["subscription"] extends { enabled: true } ? typeof subscriptions : {}) &
	(O["organization"] extends { enabled: true } ? typeof organization : {});

export const getSchema = <O extends StripeOptions>(
	options: O,
): GetSchemaResult<O> => {
	let baseSchema: BetterAuthPluginDBSchema = {};

	if (options.subscription?.enabled) {
		baseSchema = {
			...createStripeSubscriptionSchema(),
			...user,
		};
	} else {
		baseSchema = {
			...user,
		};
	}

	if (options.organization?.enabled) {
		baseSchema = {
			...baseSchema,
			...organization,
		};
	}

	if (
		options.schema &&
		!options.subscription?.enabled &&
		"subscription" in options.schema
	) {
		const { subscription: _subscription, ...restSchema } = options.schema;
		return mergeSchema(baseSchema, restSchema) as GetSchemaResult<O>;
	}

	return mergeSchema(baseSchema, options.schema) as GetSchemaResult<O>;
};
