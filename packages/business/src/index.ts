import { createCreditsService } from "@app/credits";
import type { Subscription } from "@app/subscription";
import {
	createProductService,
	createSubscriptionService,
	saveProductSchema,
} from "@app/subscription";
import type { Where } from "@better-auth/core/db/adapter";
import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth";
import {
	createAuthEndpoint,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import type { AdminOptions } from "better-auth/plugins/admin";
import { createAdminAuditService } from "better-auth/plugins/admin";
import * as z from "zod";
import { businessSchema } from "./schema";
import { assertBusinessDatabase, createBusinessService } from "./service";
import type { BusinessOptions, BusinessPermission } from "./types";
import {
	creditAdjustment,
	identifier,
	membershipAdjustment,
	newOrder,
	pagination,
	paymentConfirmation,
} from "./validation";

export { createBusinessService } from "./service";
export type * from "./types";

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		business: { creator: typeof business };
	}
}

/** One server-side composition plugin for the dashboard and purchase routes. */
export function business(options: BusinessOptions = {}) {
	function service(ctx: GenericEndpointContext) {
		const subscription = ctx.context.getPlugin("subscription");
		if (!subscription) throw new Error("Business requires subscription");
		return createBusinessService(
			ctx.context.adapter,
			subscription.options,
			options,
		);
	}
	const sessionMiddleware = createAuthMiddleware(async (ctx) => {
		const session = await getAuthoritativeSessionFromCtx(ctx);
		if (!session)
			throw new APIError("UNAUTHORIZED", { message: "Sign in required" });
		if ("banned" in session.user && session.user.banned)
			throw new APIError("FORBIDDEN", { message: "Account is banned" });
		return { session };
	});
	const authorize = (permission: BusinessPermission) =>
		createAuthMiddleware(async (ctx) => {
			const session = await getAuthoritativeSessionFromCtx(ctx);
			if (!session)
				throw new APIError("UNAUTHORIZED", { message: "Sign in required" });
			if ("banned" in session.user && session.user.banned)
				throw new APIError("FORBIDDEN", { message: "Account is banned" });
			if ("impersonatedBy" in session.session && session.session.impersonatedBy)
				throw new APIError("FORBIDDEN", {
					message: "End impersonation before administering business data",
				});
			const admin = ctx.context.getPlugin("admin") as {
				options: AdminOptions;
			} | null;
			const roles =
				typeof admin?.options.adminRoles === "string"
					? admin.options.adminRoles.split(",")
					: (admin?.options.adminRoles ?? ["admin"]);
			const role =
				"role" in session.user && typeof session.user.role === "string"
					? session.user.role
					: "";
			const allowed = options.authorize
				? await options.authorize({ ...session, permission })
				: admin?.options.adminUserIds?.includes(session.user.id) ||
					role.split(",").some((value) => roles.includes(value));
			if (!allowed)
				throw new APIError("FORBIDDEN", {
					message: `Not allowed: ${permission}`,
				});
			return { session };
		});
	async function requireUser(ctx: GenericEndpointContext, id: string) {
		const user = await ctx.context.internalAdapter.findUserById(id);
		if (!user) throw new APIError("NOT_FOUND", { message: "User not found" });
		return user;
	}
	const read = (permission: BusinessPermission) => ({
		method: "GET" as const,
		requireHeaders: true,
		use: [authorize(permission)],
		metadata: { noStore: true },
	});
	const write = (permission: BusinessPermission) => ({
		method: "POST" as const,
		requireHeaders: true,
		use: [authorize(permission)],
		metadata: { noStore: true },
	});
	return {
		id: "business",
		options,
		schema: businessSchema,
		init(ctx) {
			if (!ctx.getPlugin("subscription")?.options.catalog)
				throw new Error("Business requires subscription({ catalog: true })");
			if (!ctx.getPlugin("credits"))
				throw new Error("Business requires credits()");
			if (
				!(ctx.getPlugin("admin") as { options: AdminOptions } | null)?.options
					.auditLog
			)
				throw new Error("Business requires admin({ auditLog: true })");
			assertBusinessDatabase(ctx.adapter);
		},
		endpoints: {
			listBusinessProducts: createAuthEndpoint(
				"/business/products",
				{
					method: "GET",
					requireHeaders: true,
					use: [sessionMiddleware],
					query: pagination.optional(),
					metadata: { noStore: true },
				},
				async (ctx) =>
					service(ctx).products.list({ ...ctx.query, publishedOnly: true }),
			),
			createBusinessOrder: createAuthEndpoint(
				"/business/orders/create",
				{
					method: "POST",
					requireHeaders: true,
					use: [sessionMiddleware],
					body: newOrder,
					metadata: { noStore: true },
				},
				async (ctx) =>
					service(ctx).createOrder(ctx.context.session.user.id, ctx.body),
			),
			checkoutBusinessOrder: createAuthEndpoint(
				"/business/orders/checkout",
				{
					method: "POST",
					requireHeaders: true,
					use: [sessionMiddleware],
					body: z.object({ orderId: identifier }),
					metadata: { noStore: true },
				},
				async (ctx) =>
					service(ctx).checkout(ctx.context.session.user.id, ctx.body.orderId),
			),
			listOwnBusinessOrders: createAuthEndpoint(
				"/business/orders",
				{
					method: "GET",
					requireHeaders: true,
					use: [sessionMiddleware],
					query: pagination.optional(),
					metadata: { noStore: true },
				},
				async (ctx) =>
					service(ctx).listOrders({
						...ctx.query,
						referenceId: ctx.context.session.user.id,
					}),
			),
			/** Trusted payment callback; provider verification happens before any local write. */
			confirmBusinessPayment: createAuthEndpoint.serverOnly(
				{ method: "POST", body: paymentConfirmation },
				async (ctx) =>
					service(ctx).confirmPayment(ctx.body.orderId, ctx.body.reference),
			),
			/** Each actually paid renewal gets a distinct order; no scheduled grants or charges. */
			confirmBusinessRenewal: createAuthEndpoint.serverOnly(
				{ method: "POST", body: paymentConfirmation },
				async (ctx) =>
					service(ctx).confirmRenewal(ctx.body.orderId, ctx.body.reference),
			),
			/** Reconcile a completed refund; this never initiates a charge or refund. */
			confirmBusinessRefund: createAuthEndpoint.serverOnly(
				{ method: "POST", body: paymentConfirmation },
				async (ctx) =>
					service(ctx).confirmRefund(ctx.body.orderId, ctx.body.reference),
			),
			listBusinessCatalog: createAuthEndpoint(
				"/business/admin/products",
				{
					...read("catalog:read"),
					query: pagination.optional(),
				},
				async (ctx) => service(ctx).products.list(ctx.query),
			),
			saveBusinessProduct: createAuthEndpoint(
				"/business/admin/products/save",
				{
					...write("catalog:write"),
					body: z.object({
						operationId: identifier,
						reason: z.string().trim().min(1).max(500),
						product: saveProductSchema,
					}),
				},
				async (ctx) => {
					const actorId = ctx.context.session.user.id;
					return service(ctx).manual(
						actorId,
						ctx.body.operationId,
						actorId,
						"product.save",
						ctx.body.reason,
						ctx.body.product,
						async (db) => createProductService(db).save(ctx.body.product),
						ctx.body.product.key,
					);
				},
			),
			publishBusinessProduct: createAuthEndpoint(
				"/business/admin/products/publish",
				{
					...write("catalog:write"),
					body: z.object({
						operationId: identifier,
						reason: z.string().trim().min(1).max(500),
						key: identifier,
						expectedVersion: z.number().int().min(1),
						published: z.boolean(),
					}),
				},
				async (ctx) => {
					const actorId = ctx.context.session.user.id;
					return service(ctx).manual(
						actorId,
						ctx.body.operationId,
						actorId,
						"product.publish",
						ctx.body.reason,
						ctx.body,
						async (db) => createProductService(db).setPublished(ctx.body),
						ctx.body.key,
					);
				},
			),
			listBusinessOrders: createAuthEndpoint(
				"/business/admin/orders",
				{
					...read("orders:read"),
					query: pagination
						.extend({
							referenceId: identifier.optional(),
							status: z
								.enum([
									"pending",
									"paid",
									"fulfilled",
									"partially_refunded",
									"refunded",
								])
								.optional(),
						})
						.optional(),
				},
				async (ctx) => service(ctx).listOrders(ctx.query),
			),
			retryBusinessFulfillment: createAuthEndpoint(
				"/business/admin/orders/retry",
				{
					...write("orders:retry"),
					body: z.object({ orderId: identifier }),
				},
				async (ctx) =>
					service(ctx).fulfill(ctx.body.orderId, ctx.context.session.user.id),
			),
			adjustBusinessCredits: createAuthEndpoint(
				"/business/admin/credits/adjust",
				{
					...write("credits:adjust"),
					body: creditAdjustment,
				},
				async (ctx) => {
					await requireUser(ctx, ctx.body.referenceId);
					return service(ctx).adjustCredits(
						ctx.context.session.user.id,
						ctx.body,
					);
				},
			),
			adjustBusinessMembership: createAuthEndpoint(
				"/business/admin/membership/adjust",
				{
					...write("membership:adjust"),
					body: membershipAdjustment,
				},
				async (ctx) => {
					await requireUser(ctx, ctx.body.referenceId);
					return service(ctx).adjustMembership(
						ctx.context.session.user.id,
						ctx.body,
					);
				},
			),
			getBusinessCustomer: createAuthEndpoint(
				"/business/admin/customer",
				{
					...read("customers:read"),
					query: z.object({ referenceId: identifier }),
				},
				async (ctx) => {
					const user = await requireUser(ctx, ctx.query.referenceId);
					const plugin = ctx.context.getPlugin("subscription")!;
					const [subscriptions, credits, orders] = await Promise.all([
						createSubscriptionService(ctx.context.adapter, plugin.options).list(
							{ referenceId: user.id, activeOnly: false },
						),
						createCreditsService(ctx.context.adapter).balance(user.id),
						service(ctx).listOrders({ referenceId: user.id }),
					]);
					return {
						user: {
							id: user.id,
							name: user.name,
							email: user.email,
							createdAt: user.createdAt,
						},
						subscriptions,
						credits,
						orders,
					};
				},
			),
			listBusinessSubscriptions: createAuthEndpoint(
				"/business/admin/subscriptions",
				{
					...read("customers:read"),
					query: pagination
						.extend({
							referenceId: identifier.optional(),
							status: z
								.enum([
									"active",
									"canceled",
									"incomplete",
									"incomplete_expired",
									"past_due",
									"paused",
									"trialing",
									"unpaid",
								])
								.optional(),
						})
						.optional(),
				},
				async (ctx) => {
					const { limit, offset } = pagination.parse(ctx.query ?? {});
					const where: Where[] = [];
					if (ctx.query?.referenceId)
						where.push({ field: "referenceId", value: ctx.query.referenceId });
					if (ctx.query?.status)
						where.push({ field: "status", value: ctx.query.status });
					const adapter = ctx.context.adapter;
					return {
						subscriptions: await adapter.findMany<Subscription>({
							model: "subscription",
							where,
							limit,
							offset,
							sortBy: { field: "id", direction: "asc" },
						}),
						total: await adapter.count({ model: "subscription", where }),
						limit,
						offset,
					};
				},
			),
			getBusinessLedger: createAuthEndpoint(
				"/business/admin/credits/ledger",
				{
					...read("customers:read"),
					query: z.object({
						referenceId: identifier,
						limit: z.coerce.number().int().min(1).max(100).default(20),
						cursor: z.coerce.number().int().min(1).optional(),
					}),
				},
				async (ctx) =>
					createCreditsService(ctx.context.adapter).ledger(ctx.query),
			),
			getBusinessOverview: createAuthEndpoint(
				"/business/admin/overview",
				read("metrics:read"),
				async (ctx) => service(ctx).overview(),
			),
			listBusinessAuditLogs: createAuthEndpoint(
				"/business/admin/audit",
				{
					...read("audit:read"),
					query: pagination
						.extend({
							actorId: identifier.optional(),
							targetId: identifier.optional(),
						})
						.optional(),
				},
				async (ctx) =>
					createAdminAuditService(ctx.context.adapter).list(
						ctx.query ?? { limit: 20, offset: 0 },
					),
			),
		},
	} satisfies BetterAuthPlugin;
}
