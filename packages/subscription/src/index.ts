import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";
import type {
	BetterAuthPlugin,
	GenericEndpointContext,
	InferOptionSchema,
	Session,
	User,
} from "better-auth";
import { APIError } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { mergeSchema } from "better-auth/db";
import * as z from "zod";
import {
	createProductService,
	publishProductSchema,
	saveProductSchema,
} from "./product";
import {
	createProductSchema,
	createProviderSubscriptionSchema,
} from "./schema";
import { createSubscriptionService, syncSubscriptionSchema } from "./service";
import type { SubscriptionPlans } from "./types";

export type { Product, SaveProductInput } from "./product";
export {
	createProductService,
	productPlanName,
	publishProductSchema,
	saveProductSchema,
} from "./product";
export type { SubscriptionSyncInput } from "./service";
export { createSubscriptionService, syncSubscriptionSchema } from "./service";

export type {
	Subscription,
	SubscriptionPlan,
	SubscriptionPlans,
} from "./types";
export {
	isActiveOrTrialing,
	isSubscriptionActive,
	resolvePlans,
} from "./utils";

/** Configure plans, ownership authorization, and shared database field mappings. */
interface SubscriptionBaseOptions {
	/** Authorize reads for an organization or reference other than the current user. */
	authorizeReference?: (
		data: { user: User; session: Session; referenceId: string },
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;
	schema?: InferOptionSchema<
		ReturnType<typeof createProviderSubscriptionSchema> &
			ReturnType<typeof createProductSchema>
	>;
}

/** Supply configured plans, or explicitly enable the persistent product catalog. */
export type SubscriptionOptions = SubscriptionBaseOptions &
	(
		| { plans: SubscriptionPlans; catalog?: boolean }
		| { plans?: SubscriptionPlans; catalog: true }
	);

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		subscription: { creator: typeof subscription };
	}
}

const identifier = z.string().trim().min(1).max(255);

/** Manage common subscription state; payment collection remains in provider packages. */
export function subscription(options: SubscriptionOptions) {
	if (!options.plans && !options.catalog)
		throw new Error("Configure subscription plans or enable catalog");
	const schema = mergeSchema(
		{
			...createProviderSubscriptionSchema(),
			...(options.catalog ? createProductSchema() : {}),
		},
		options.schema,
	);

	return {
		id: "subscription",
		options,
		schema,
		init(ctx) {
			const ownTable: BetterAuthPluginDBSchema[string] = schema.subscription;
			for (const plugin of ctx.options.plugins ?? []) {
				const table = plugin.schema?.subscription;
				if (!table || plugin.id === "subscription") continue;
				if (
					(table.modelName ?? "subscription") !==
					(ownTable.modelName ?? "subscription")
				) {
					throw new Error(
						`Subscription table mapping conflicts with plugin "${plugin.id}"; use the same subscription.modelName in both plugins`,
					);
				}
				for (const [field, definition] of Object.entries(table.fields)) {
					const ownField = ownTable.fields[field];
					if (
						ownField &&
						(definition.fieldName ?? field) !== (ownField.fieldName ?? field)
					) {
						throw new Error(
							`Subscription field "${field}" mapping conflicts with plugin "${plugin.id}"; use the same field mapping in both plugins`,
						);
					}
				}
			}
		},
		endpoints: {
			saveSubscriptionProduct: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					metadata: { SERVER_ONLY: true },
					body: saveProductSchema,
				},
				async (ctx) => {
					if (!options.catalog)
						throw new APIError("BAD_REQUEST", {
							message: "Product catalog is disabled",
						});
					return createProductService(ctx.context.adapter).save(ctx.body);
				},
			),
			publishSubscriptionProduct: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					metadata: { SERVER_ONLY: true },
					body: publishProductSchema,
				},
				async (ctx) => {
					if (!options.catalog)
						throw new APIError("BAD_REQUEST", {
							message: "Product catalog is disabled",
						});
					return createProductService(ctx.context.adapter).setPublished(
						ctx.body,
					);
				},
			),
			listSubscriptionPlans: createAuthEndpoint(
				"/subscriptions/plans",
				{ method: "GET", requireHeaders: true, use: [sessionMiddleware] },
				async (ctx) => {
					const plans = await createSubscriptionService(
						ctx.context.adapter,
						options,
					).plans();
					return ctx.json(
						plans.map(({ name, limits, group }) => ({ name, limits, group })),
					);
				},
			),
			listCustomerSubscriptions: createAuthEndpoint(
				"/subscriptions/list",
				{
					method: "GET",
					requireHeaders: true,
					use: [sessionMiddleware],
					query: z
						.object({
							referenceId: identifier.optional(),
							activeOnly: z
								.union([
									z.boolean(),
									z
										.enum(["true", "false"])
										.transform((value) => value === "true"),
								])
								.default(true),
						})
						.optional(),
				},
				async (ctx) => {
					const { user, session } = ctx.context.session;
					const referenceId = ctx.query?.referenceId ?? user.id;
					if (
						referenceId !== user.id &&
						!(await options.authorizeReference?.(
							{ user, session, referenceId },
							ctx,
						))
					) {
						throw new APIError("FORBIDDEN", {
							message: "Not authorized to read these subscriptions",
						});
					}
					return ctx.json(
						await createSubscriptionService(ctx.context.adapter, options).list({
							referenceId,
							activeOnly: ctx.query?.activeOnly ?? true,
						}),
					);
				},
			),
			/** Synchronize only after trusted server code has verified the payment provider. */
			syncSubscription: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					metadata: { SERVER_ONLY: true },
					body: syncSubscriptionSchema,
				},
				async (ctx) => {
					return createSubscriptionService(ctx.context.adapter, options).sync(
						ctx.body,
					);
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
