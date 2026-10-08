import { createCreditsService } from "@app/credits";
import type { Subscription, SubscriptionOptions } from "@app/subscription";
import {
	createProductService,
	createSubscriptionService,
	productPlanName,
} from "@app/subscription";
import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth";
import { createAdminAuditService } from "better-auth/plugins/admin";
import type * as z from "zod";
import type { BusinessJSON, BusinessOptions, BusinessOrder } from "./types";
import {
	canonicalJSON,
	compositeKey,
	creditAdjustment,
	membershipAdjustment,
	newOrder,
	pagination,
	verifiedPayment,
	verifiedRefund,
} from "./validation";

const day = 86_400_000;
const fail = (message: string) => new APIError("CONFLICT", { message });

/** Business writes require real transactions, not an adapter's sequential fallback. */
export function assertBusinessDatabase<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
) {
	if (!adapter.options?.adapterConfig.transaction || adapter.id === "memory") {
		throw new Error(
			"Business requires a SQL adapter with real transactions and unique indexes",
		);
	}
}

/** Compose existing plugin services without calling HTTP or bypassing their write validation. */
export function createBusinessService<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
	subscriptionOptions: SubscriptionOptions,
	options: BusinessOptions,
) {
	assertBusinessDatabase(adapter);
	const products = createProductService(adapter);
	const ttl = options.orderTtlMs ?? 30 * 60_000;
	if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 365 * day)
		throw new Error("Invalid business orderTtlMs");

	async function getOrder(id: string, db = adapter) {
		const order = await db.findOne<BusinessOrder>({
			model: "businessOrder",
			where: [{ field: "id", value: id }],
		});
		if (!order) throw new APIError("NOT_FOUND", { message: "Order not found" });
		return order;
	}
	function provider(name: string) {
		const value = Object.hasOwn(options.providers ?? {}, name)
			? options.providers?.[name]
			: undefined;
		if (!value)
			throw new APIError("BAD_REQUEST", {
				message: "Payment provider is not configured",
			});
		return value;
	}
	async function ensureCustomer(referenceId: string) {
		const where = [{ field: "referenceId", value: referenceId }];
		if (await adapter.findOne({ model: "businessCustomer", where })) return;
		try {
			await adapter.create({
				model: "businessCustomer",
				data: { referenceId, updatedAt: new Date(), lastPaidAt: null },
			});
		} catch (error) {
			if (!(await adapter.findOne({ model: "businessCustomer", where })))
				throw error;
		}
	}
	async function transaction<T>(
		referenceId: string,
		operation: (db: DBAdapter<Options>) => Promise<T>,
	) {
		await ensureCustomer(referenceId);
		return adapter.transaction(async (tx) => {
			const db: DBAdapter<Options> = {
				...tx,
				transaction: async (callback) => callback(tx),
			};
			// A database row write serializes each customer's business operations across instances.
			await db.updateMany({
				model: "businessCustomer",
				where: [{ field: "referenceId", value: referenceId }],
				update: { updatedAt: new Date() },
			});
			return operation(db);
		});
	}
	async function createOrder(
		referenceId: string,
		input: z.input<typeof newOrder>,
	) {
		const body = newOrder.parse(input);
		provider(body.provider);
		return transaction(referenceId, async (db) => {
			const checkoutKey = await compositeKey(
				"checkout",
				referenceId,
				body.idempotencyKey,
			);
			const existing = await db.findOne<BusinessOrder>({
				model: "businessOrder",
				where: [{ field: "checkoutKey", value: checkoutKey }],
			});
			if (existing) {
				if (
					existing.productId !== body.productId ||
					existing.provider !== body.provider
				)
					throw fail("Order idempotency key conflicts with another purchase");
				return existing;
			}
			const product = await createProductService(db).get(body.productId);
			if (
				!product ||
				!product.published ||
				(await createProductService(db).getLatest(product.key))?.id !==
					product.id
			) {
				throw new APIError("BAD_REQUEST", {
					message: "Product is not currently published",
				});
			}
			if (product.amount <= 0)
				throw new APIError("BAD_REQUEST", {
					message: "Paid checkout requires a positive amount",
				});
			const createdAt = new Date();
			return db.create<Omit<BusinessOrder, "id">, BusinessOrder>({
				model: "businessOrder",
				data: {
					referenceId,
					checkoutKey,
					provider: body.provider,
					productId: product.id,
					productKey: product.key,
					parentOrderId: null,
					product: { ...product, createdAt: product.createdAt.toISOString() },
					amount: product.amount,
					currency: product.currency,
					status: "pending",
					providerOrderId: null,
					providerKey: null,
					checkoutURL: null,
					paymentId: null,
					paidAt: null,
					periodStart: null,
					periodEnd: null,
					refundedAmount: 0,
					reviewRequired: false,
					createdAt,
					expiresAt: new Date(createdAt.getTime() + ttl),
					fulfilledAt: null,
				},
			});
		});
	}
	async function checkout(referenceId: string, orderId: string) {
		const order = await getOrder(orderId);
		if (order.referenceId !== referenceId)
			throw new APIError("FORBIDDEN", {
				message: "Order does not belong to this user",
			});
		if (order.status !== "pending") return order;
		if (Date.now() >= order.expiresAt.getTime())
			throw new APIError("BAD_REQUEST", {
				message: "Payment window ended; existing payments still reconcile",
			});
		if (order.providerOrderId && order.checkoutURL) return order;
		const result = await provider(order.provider).createCheckout(order);
		const url = new URL(result.url);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			!result.providerOrderId ||
			result.providerOrderId.length > 128
		)
			throw fail("Invalid provider checkout response");
		return transaction(referenceId, async (db) => {
			const current = await getOrder(orderId, db);
			if (current.providerOrderId) {
				if (current.providerOrderId !== result.providerOrderId)
					throw fail("Provider did not preserve checkout idempotency");
				return current;
			}
			await db.update({
				model: "businessOrder",
				where: [{ field: "id", value: orderId }],
				update: {
					providerOrderId: result.providerOrderId,
					providerKey: await compositeKey(
						"provider",
						order.provider,
						result.providerOrderId,
					),
					checkoutURL: result.url,
				},
			});
			return getOrder(orderId, db);
		});
	}
	async function recordEvent(
		db: DBAdapter<Options>,
		order: BusinessOrder,
		kind: "payment" | "refund",
		id: string,
		payload: unknown,
	) {
		const eventKey = await compositeKey("event", order.provider, kind, id);
		const existing = await db.findOne<{ orderId: string; payload: unknown }>({
			model: "businessPaymentEvent",
			where: [{ field: "eventKey", value: eventKey }],
		});
		if (existing) {
			if (
				existing.orderId !== order.id ||
				canonicalJSON(existing.payload) !== canonicalJSON(payload)
			)
				throw fail("Payment event was already used with different data");
			return false;
		}
		await db.create({
			model: "businessPaymentEvent",
			data: {
				eventKey,
				orderId: order.id,
				kind,
				payload,
				createdAt: new Date(),
			},
		});
		return true;
	}
	async function fulfill(orderId: string, actorId = "system") {
		const initial = await getOrder(orderId);
		return transaction(initial.referenceId, async (db) => {
			const order = await getOrder(orderId, db);
			if (order.fulfilledAt || order.status === "refunded") return order;
			if (!order.paidAt || !order.paymentId)
				throw fail("Cannot fulfill an unpaid order");
			const { product } = order;
			if (product.type !== "credits") {
				await createSubscriptionService(db, subscriptionOptions).sync({
					provider: "business",
					providerSubscriptionId: order.id,
					referenceId: order.referenceId,
					plan: productPlanName(product),
					status: "active",
					revision: 0,
					periodStart: order.periodStart!,
					periodEnd: order.periodEnd!,
				});
			}
			if (product.credits > 0) {
				await createCreditsService(db).grant({
					referenceId: order.referenceId,
					amount: product.credits,
					idempotencyKey: await compositeKey("grant", order.id),
					source: `order:${order.id}`,
					reason: "Paid purchase",
					expiresAt: product.creditValidityDays
						? new Date(
								order.paidAt.getTime() + product.creditValidityDays * day,
							)
						: undefined,
				});
			}
			await createAdminAuditService(db).record({
				operationId: await compositeKey("fulfill", order.id),
				actorId,
				action: "order.fulfill",
				targetId: order.id,
				reason:
					actorId === "system"
						? "Verified payment"
						: "Retry paid order fulfillment",
				status: "succeeded",
			});
			await db.update({
				model: "businessOrder",
				where: [{ field: "id", value: order.id }],
				update: {
					status: order.refundedAmount > 0 ? "partially_refunded" : "fulfilled",
					fulfilledAt: new Date(),
				},
			});
			return getOrder(order.id, db);
		});
	}
	async function applyPayment(
		orderId: string,
		payment: z.output<typeof verifiedPayment>,
	) {
		const initial = await getOrder(orderId);
		if (
			payment.amount !== initial.amount ||
			payment.currency !== initial.currency ||
			payment.providerOrderId !== initial.providerOrderId ||
			payment.paidAt.getTime() > Date.now()
		)
			throw fail("Verified payment does not match the saved checkout");
		await transaction(initial.referenceId, async (db) => {
			const order = await getOrder(orderId, db);
			const fresh = await recordEvent(
				db,
				order,
				"payment",
				payment.paymentId,
				payment,
			);
			if (!fresh) return;
			if (order.paymentId && order.paymentId !== payment.paymentId)
				throw fail("Order already has a different payment; reconcile manually");
			let periodStart: Date | null = null;
			let periodEnd: Date | null = null;
			if (order.product.type !== "credits") {
				periodStart = payment.periodStart ?? payment.paidAt;
				if (!payment.periodStart) {
					const active = await createSubscriptionService(
						db,
						subscriptionOptions,
					).list({ referenceId: order.referenceId, activeOnly: false });
					// Versions keep their own benefits; prepaid time queues by the stable product key.
					for (const item of active) {
						if (
							item.status === "active" &&
							!item.endedAt &&
							!item.cancelAt &&
							item.plan.startsWith("product:") &&
							item.periodEnd &&
							item.periodEnd > periodStart &&
							(await createProductService(db).get(item.plan.slice(8)))?.key ===
								order.productKey
						)
							periodStart = item.periodEnd;
					}
					const [reserved] = await db.findMany<BusinessOrder>({
						model: "businessOrder",
						where: [
							{ field: "referenceId", value: order.referenceId },
							{ field: "productKey", value: order.productKey },
							{ field: "fulfilledAt", value: null },
							{
								field: "status",
								operator: "in",
								value: ["paid", "partially_refunded"],
							},
						],
						limit: 1,
						sortBy: { field: "periodEnd", direction: "desc" },
					});
					if (reserved?.periodEnd && reserved.periodEnd > periodStart)
						periodStart = reserved.periodEnd;
				}
				periodEnd =
					payment.periodEnd ??
					new Date(periodStart.getTime() + order.product.membershipDays! * day);
				if (!Number.isFinite(periodEnd.getTime()) || periodEnd <= periodStart)
					throw fail("Invalid membership deadline");
			}
			await db.update({
				model: "businessOrder",
				where: [{ field: "id", value: orderId }],
				update: {
					paymentId: payment.paymentId,
					paidAt: payment.paidAt,
					periodStart,
					periodEnd,
					status: "paid",
				},
			});
			const customer = await db.findOne<{ lastPaidAt: Date | null }>({
				model: "businessCustomer",
				where: [{ field: "referenceId", value: order.referenceId }],
			});
			if (!customer?.lastPaidAt || customer.lastPaidAt < payment.paidAt)
				await db.updateMany({
					model: "businessCustomer",
					where: [{ field: "referenceId", value: order.referenceId }],
					update: { lastPaidAt: payment.paidAt },
				});
		});
		// Receipt survives a fulfillment failure. Retry never needs to charge the user again.
		return fulfill(orderId);
	}
	async function confirmPayment(orderId: string, reference: string) {
		const order = await getOrder(orderId);
		const payment = verifiedPayment.parse(
			await provider(order.provider).verifyPayment({ order, reference }),
		);
		return applyPayment(orderId, payment);
	}
	async function confirmRenewal(orderId: string, reference: string) {
		const original = await getOrder(orderId);
		if (!original.paymentId)
			throw fail("Reconcile the original purchase before a renewal");
		const payment = verifiedPayment.parse(
			await provider(original.provider).verifyPayment({
				order: original,
				reference,
			}),
		);
		if (
			!payment.periodStart ||
			!payment.periodEnd ||
			payment.amount !== original.amount ||
			payment.currency !== original.currency ||
			payment.providerOrderId !== original.providerOrderId ||
			payment.paymentId === original.paymentId ||
			payment.paidAt.getTime() > Date.now()
		)
			throw fail(
				"Renewal must identify a new verified payment and its absolute billing period",
			);
		const renewal = await transaction(original.referenceId, async (db) => {
			const checkoutKey = await compositeKey(
				"renewal",
				original.provider,
				payment.paymentId,
			);
			const existing = await db.findOne<BusinessOrder>({
				model: "businessOrder",
				where: [{ field: "checkoutKey", value: checkoutKey }],
			});
			if (existing) {
				if (existing.parentOrderId !== original.id)
					throw fail("Renewal payment belongs to another purchase");
				return existing;
			}
			return db.create<Omit<BusinessOrder, "id">, BusinessOrder>({
				model: "businessOrder",
				data: {
					referenceId: original.referenceId,
					checkoutKey,
					provider: original.provider,
					productId: original.productId,
					productKey: original.productKey,
					parentOrderId: original.id,
					product: original.product,
					amount: original.amount,
					currency: original.currency,
					status: "pending",
					providerOrderId: original.providerOrderId,
					providerKey: null,
					checkoutURL: null,
					paymentId: null,
					paidAt: null,
					periodStart: null,
					periodEnd: null,
					refundedAmount: 0,
					reviewRequired: false,
					createdAt: new Date(),
					expiresAt: new Date(payment.paidAt.getTime() + ttl),
					fulfilledAt: null,
				},
			});
		});
		return applyPayment(renewal.id, payment);
	}
	async function confirmRefund(orderId: string, reference: string) {
		const initial = await getOrder(orderId);
		const verify = provider(initial.provider).verifyRefund;
		if (!verify)
			throw new APIError("BAD_REQUEST", {
				message: "Verified refund integration is not configured",
			});
		const refund = verifiedRefund.parse(
			await verify({ order: initial, reference }),
		);
		if (
			refund.currency !== initial.currency ||
			refund.paymentId !== initial.paymentId ||
			refund.refundedAt.getTime() > Date.now()
		)
			throw fail("Refund does not belong to the saved payment");
		return transaction(initial.referenceId, async (db) => {
			const order = await getOrder(orderId, db);
			if (!order.paidAt || !order.paymentId)
				throw fail("Payment must be reconciled before its refund");
			if (!(await recordEvent(db, order, "refund", refund.refundId, refund)))
				return order;
			const refundedAmount = order.refundedAmount + refund.amount;
			if (
				!Number.isSafeInteger(refundedAmount) ||
				refundedAmount > order.amount
			)
				throw fail("Refund exceeds the order amount");
			let reviewRequired = refundedAmount < order.amount;
			if (refundedAmount === order.amount && order.fulfilledAt) {
				if (order.product.type !== "credits") {
					const existing = await db.findOne<Subscription>({
						model: "subscription",
						where: [
							{ field: "provider", value: "business" },
							{ field: "providerSubscriptionId", value: order.id },
						],
					});
					if (!existing)
						throw fail("Fulfilled membership is missing; reconcile manually");
					await createSubscriptionService(db, subscriptionOptions).sync({
						provider: "business",
						providerSubscriptionId: order.id,
						referenceId: order.referenceId,
						plan: existing.plan,
						status: "canceled",
						revision: (existing.revision ?? 0) + 1,
						periodStart: existing.periodStart!,
						periodEnd: existing.periodEnd!,
						endedAt: refund.refundedAt,
					});
				}
				if (order.product.credits > 0) {
					const result = await createCreditsService(db).revokeGrant({
						referenceId: order.referenceId,
						grantKey: await compositeKey("grant", order.id),
						idempotencyKey: await compositeKey("revoke", order.id),
						reason: "Verified full refund",
					});
					reviewRequired = result.unavailable > 0;
				}
			}
			await createAdminAuditService(db).record({
				operationId: await compositeKey("refund", order.id, refund.refundId),
				actorId: "system",
				action: "order.refund",
				targetId: order.id,
				reason: "Verified refund",
				status: "succeeded",
				details: { refundedAmount, reviewRequired },
			});
			await db.update({
				model: "businessOrder",
				where: [{ field: "id", value: orderId }],
				update: {
					refundedAmount,
					reviewRequired,
					status:
						refundedAmount === order.amount ? "refunded" : "partially_refunded",
				},
			});
			return getOrder(orderId, db);
		});
	}
	async function listOrders(
		input: {
			referenceId?: string;
			status?: BusinessOrder["status"];
			limit?: number;
			offset?: number;
		} = {},
	) {
		const { limit, offset } = pagination.parse(input);
		const where: Where[] = [];
		if (input.referenceId)
			where.push({ field: "referenceId", value: input.referenceId });
		if (input.status) where.push({ field: "status", value: input.status });
		return {
			orders: await adapter.findMany<BusinessOrder>({
				model: "businessOrder",
				where,
				limit,
				offset,
				sortBy: { field: "createdAt", direction: "desc" },
			}),
			total: await adapter.count({ model: "businessOrder", where }),
			limit,
			offset,
		};
	}
	async function manual<T>(
		actorId: string,
		operationId: string,
		referenceId: string,
		action: string,
		reason: string,
		payload: unknown,
		execute: (db: DBAdapter<Options>) => Promise<T>,
		targetId = referenceId,
	) {
		return transaction(referenceId, async (db) => {
			const actionKey = await compositeKey("admin", actorId, operationId);
			const fullPayload = { action, reason, payload };
			const prior = await db.findOne<{
				payload: unknown;
				result: BusinessJSON<T>;
			}>({
				model: "businessAction",
				where: [{ field: "actionKey", value: actionKey }],
			});
			if (prior) {
				if (canonicalJSON(prior.payload) !== canonicalJSON(fullPayload))
					throw fail(
						"Administrative operation key conflicts with another request",
					);
				return JSON.parse(JSON.stringify(prior.result)) as BusinessJSON<T>;
			}
			const result = JSON.parse(
				JSON.stringify(await execute(db)),
			) as BusinessJSON<T>;
			await db.create({
				model: "businessAction",
				data: {
					actionKey,
					actorId,
					payload: fullPayload,
					result,
					createdAt: new Date(),
				},
			});
			await createAdminAuditService(db).record({
				operationId: actionKey,
				actorId,
				action,
				targetId,
				reason,
				status: "succeeded",
			});
			return result;
		});
	}
	async function adjustCredits(
		actorId: string,
		input: z.input<typeof creditAdjustment>,
	) {
		const body = creditAdjustment.parse(input);
		if (body.action === "consume" && body.expiresAt)
			throw new APIError("BAD_REQUEST", {
				message: "Only grants have an expiration",
			});
		return manual(
			actorId,
			body.operationId,
			body.referenceId,
			`credits.${body.action}`,
			body.reason,
			body,
			async (db) => {
				const credits = createCreditsService(db);
				const mutation = {
					referenceId: body.referenceId,
					amount: body.amount,
					idempotencyKey: await compositeKey(
						"admin-credit",
						actorId,
						body.operationId,
					),
					reason: body.reason,
				};
				return body.action === "grant"
					? credits.grant({
							...mutation,
							source: "admin",
							expiresAt: body.expiresAt,
						})
					: credits.consume(mutation);
			},
		);
	}
	async function adjustMembership(
		actorId: string,
		input: z.input<typeof membershipAdjustment>,
	) {
		const body = membershipAdjustment.parse(input);
		return manual(
			actorId,
			body.operationId,
			body.referenceId,
			"membership.adjust",
			body.reason,
			body,
			async (db) => {
				const product = await createProductService(db).get(body.productId);
				if (!product || product.type === "credits")
					throw new APIError("BAD_REQUEST", {
						message: "A membership product is required",
					});
				const existing = body.subscriptionId
					? await db.findOne<Subscription>({
							model: "subscription",
							where: [{ field: "id", value: body.subscriptionId }],
						})
					: null;
				if (
					body.subscriptionId &&
					(!existing || existing.referenceId !== body.referenceId)
				)
					throw new APIError("NOT_FOUND", {
						message: "Membership not found for this user",
					});
				if (existing && existing.provider !== "business")
					throw fail(
						"Manage provider-owned subscriptions through their existing payment integration",
					);
				if (existing && existing.revision !== body.expectedRevision)
					throw fail("Membership changed; refresh before adjusting");
				if (
					existing &&
					(await db.findOne({
						model: "businessOrder",
						where: [
							{ field: "id", value: existing.providerSubscriptionId! },
							{ field: "status", value: "refunded" },
						],
					}))
				)
					throw fail(
						"Refunded memberships cannot be reactivated; create a new adjustment",
					);
				return createSubscriptionService(db, subscriptionOptions).sync({
					provider: "business",
					providerSubscriptionId:
						existing?.providerSubscriptionId ??
						(await compositeKey(
							"manual-membership",
							actorId,
							body.operationId,
						)),
					referenceId: body.referenceId,
					plan: productPlanName(product),
					status: body.status,
					periodStart: body.periodStart,
					periodEnd: body.periodEnd,
					revision: existing ? existing.revision! + 1 : 0,
					endedAt: body.status === "canceled" ? new Date() : null,
				});
			},
		);
	}
	async function overview() {
		const now = new Date();
		const month = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		);
		const [totalUsers, newUsers7d, paidUsersThisMonth] = await Promise.all([
			adapter.count({ model: "user" }),
			adapter.count({
				model: "user",
				where: [
					{
						field: "createdAt",
						operator: "gte",
						value: new Date(now.getTime() - 7 * day),
					},
					{ field: "createdAt", operator: "lt", value: now },
				],
			}),
			adapter.count({
				model: "businessCustomer",
				where: [
					{ field: "lastPaidAt", operator: "gte", value: month },
					{ field: "lastPaidAt", operator: "lte", value: now },
				],
			}),
		]);
		return {
			totalUsers,
			newUsers7d,
			paymentsConfigured: Object.keys(options.providers ?? {}).length > 0,
			paidUsersThisMonth,
			generatedAt: now,
			timezone: "UTC",
			paymentScope: "business-orders",
			refundPolicy: "includes-refunded-payments",
		};
	}
	return {
		products,
		createOrder,
		checkout,
		getOrder,
		confirmPayment,
		confirmRenewal,
		confirmRefund,
		fulfill,
		listOrders,
		adjustCredits,
		adjustMembership,
		overview,
		manual,
	};
}
