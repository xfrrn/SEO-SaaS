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
import { createProviderSubscriptionSchema } from "./schema";
import type { Subscription, SubscriptionPlans } from "./types";
import { isSubscriptionActive, resolvePlans } from "./utils";

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
export interface SubscriptionOptions {
	plans: SubscriptionPlans;
	/** Authorize reads for an organization or reference other than the current user. */
	authorizeReference?: (
		data: { user: User; session: Session; referenceId: string },
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;
	schema?: InferOptionSchema<
		ReturnType<typeof createProviderSubscriptionSchema>
	>;
}

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		subscription: { creator: typeof subscription };
	}
}

const identifier = z.string().trim().min(1).max(255);
const syncBody = z
	.object({
		provider: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[a-z][a-z0-9_-]*$/),
		providerSubscriptionId: identifier,
		providerCustomerId: identifier.nullable().optional(),
		referenceId: identifier,
		plan: identifier,
		status: z.enum([
			"active",
			"canceled",
			"incomplete",
			"incomplete_expired",
			"past_due",
			"paused",
			"trialing",
			"unpaid",
		]),
		periodStart: z.date(),
		periodEnd: z.date(),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		trialStart: z.date().nullable().optional(),
		trialEnd: z.date().nullable().optional(),
		cancelAtPeriodEnd: z.boolean().optional(),
		cancelAt: z.date().nullable().optional(),
		canceledAt: z.date().nullable().optional(),
		endedAt: z.date().nullable().optional(),
		seats: z
			.number()
			.int()
			.min(0)
			.max(Number.MAX_SAFE_INTEGER)
			.nullable()
			.optional(),
		billingInterval: z
			.enum(["day", "week", "month", "year"])
			.nullable()
			.optional(),
	})
	.refine((body) => body.periodStart < body.periodEnd, {
		message: "periodEnd must be after periodStart",
		path: ["periodEnd"],
	})
	.refine(
		(body) =>
			!body.trialStart || !body.trialEnd || body.trialStart < body.trialEnd,
		{ message: "trialEnd must be after trialStart", path: ["trialEnd"] },
	);

function publicSubscription(value: Subscription) {
	return {
		id: value.id,
		plan: value.plan,
		referenceId: value.referenceId,
		status: value.status,
		periodStart: value.periodStart,
		periodEnd: value.periodEnd,
		trialStart: value.trialStart,
		trialEnd: value.trialEnd,
		cancelAtPeriodEnd: value.cancelAtPeriodEnd,
		cancelAt: value.cancelAt,
		canceledAt: value.canceledAt,
		endedAt: value.endedAt,
		seats: value.seats,
		billingInterval: value.billingInterval,
		provider: value.provider,
	};
}

/** Manage common subscription state; payment collection remains in provider packages. */
export function subscription(options: SubscriptionOptions) {
	const schema = mergeSchema(
		createProviderSubscriptionSchema(),
		options.schema,
	);

	async function getPlans() {
		const plans = await resolvePlans(options.plans);
		const names = new Set<string>();
		for (const plan of plans) {
			const name = plan.name.trim().toLowerCase();
			if (
				!name ||
				plan.name !== plan.name.trim() ||
				plan.name.length > 255 ||
				names.has(name)
			) {
				throw new APIError("BAD_REQUEST", {
					message:
						"Subscription plan names must be non-empty, unique, at most 255 characters, and have no leading or trailing whitespace",
				});
			}
			names.add(name);
		}
		return plans;
	}

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
			listSubscriptionPlans: createAuthEndpoint(
				"/subscriptions/plans",
				{ method: "GET", requireHeaders: true, use: [sessionMiddleware] },
				async (ctx) => {
					const plans = await getPlans();
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
					const plans = await getPlans();
					const where = [{ field: "referenceId", value: referenceId }];
					const count = await ctx.context.adapter.count({
						model: "subscription",
						where,
					});
					const subscriptions = count
						? await ctx.context.adapter.findMany<Subscription>({
								model: "subscription",
								where,
								limit: count,
							})
						: [];
					const now = new Date();
					return ctx.json(
						subscriptions.flatMap((value) => {
							const plan = plans.find(
								(plan) => plan.name.toLowerCase() === value.plan.toLowerCase(),
							);
							const active = !!plan && isSubscriptionActive(value, now);
							if ((ctx.query?.activeOnly ?? true) && !active) return [];
							return [
								{
									...publicSubscription(value),
									limits: active ? plan?.limits : undefined,
								},
							];
						}),
					);
				},
			),
			/** Synchronize only after trusted server code has verified the payment provider. */
			syncSubscription: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: syncBody },
				async (ctx) => {
					const body = ctx.body;
					const plans = await getPlans();
					const plan = plans.find(
						(plan) => plan.name.toLowerCase() === body.plan.toLowerCase(),
					);
					if (!plan) {
						throw new APIError("BAD_REQUEST", {
							message: "Unknown subscription plan",
						});
					}
					const syncKey = JSON.stringify([
						body.provider,
						body.providerSubscriptionId,
					]);
					const adapter = ctx.context.adapter;
					const findByKey = () =>
						adapter.findOne<Subscription>({
							model: "subscription",
							where: [{ field: "syncKey", value: syncKey }],
						});
					const data = { ...body, plan: plan.name, syncKey };
					for (let attempt = 0; attempt < 5; attempt++) {
						const current =
							(await findByKey()) ??
							(await adapter.findOne<Subscription>({
								model: "subscription",
								where: [
									{ field: "provider", value: body.provider },
									{
										field: "providerSubscriptionId",
										value: body.providerSubscriptionId,
									},
								],
							}));
						if (current) {
							if (current.referenceId !== body.referenceId) {
								throw new APIError("CONFLICT", {
									message: "A subscription cannot change its referenceId",
								});
							}
							if (
								current.revision != null &&
								current.revision >= body.revision
							) {
								return { subscription: current, applied: false };
							}
							const updated = await adapter.updateMany({
								model: "subscription",
								where: [
									{ field: "id", value: current.id },
									{ field: "revision", value: current.revision ?? null },
								],
								update: data,
							});
							if (updated) {
								const saved = await findByKey();
								if (saved) return { subscription: saved, applied: true };
							}
						} else {
							try {
								const saved = await adapter.create<typeof data, Subscription>({
									model: "subscription",
									data,
								});
								return { subscription: saved, applied: true };
							} catch (error) {
								if (!(await findByKey())) throw error;
							}
						}
					}
					throw new APIError("CONFLICT", {
						message:
							"Subscription changed concurrently; retry the synchronization",
					});
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
