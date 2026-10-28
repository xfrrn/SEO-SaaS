import type { Product } from "@app/subscription";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import { APIError } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import * as z from "zod";
import type { BusinessOrder } from "./types";
import { compositeKey } from "./validation";

/** Stored in immutable product.limits.purchase; absent means unrestricted legacy pricing. */
export const purchasePolicySchema = z
	.object({
		maxPerUser: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.nullable()
			.default(null),
		firstPurchaseOffer: z
			.discriminatedUnion("type", [
				z
					.object({
						type: z.literal("fixed"),
						amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
					})
					.strict(),
				z
					.object({
						type: z.literal("percent"),
						percentOff: z.number().int().min(1).max(99),
					})
					.strict(),
			])
			.nullable()
			.default(null),
	})
	.strict();
export type PurchasePolicy = z.infer<typeof purchasePolicySchema>;
export interface PurchaseQuote {
	productId: string;
	productKey: string;
	currency: string;
	baseAmount: number;
	amount: number;
	discountAmount: number;
	firstPurchase: boolean;
	purchaseCount: number;
	remaining: number | null;
	canPurchase: boolean;
	reason: "limit_reached" | "pending_order" | null;
	pendingOrderId: string | null;
	quoteVersion: string;
}
export interface PurchasePricing {
	baseAmount: number;
	discountAmount: number;
	firstPurchase: boolean;
	policy: PurchasePolicy;
	quoteVersion: string;
}
export function purchasePolicy(
	product: Pick<Product, "type" | "amount" | "limits">,
): PurchasePolicy {
	const parsed = purchasePolicySchema.safeParse(product.limits.purchase ?? {});
	if (
		!parsed.success ||
		(product.type !== "credits" && product.limits.purchase !== undefined)
	)
		throw new APIError("BAD_REQUEST", {
			message: "Invalid credit purchase policy",
		});
	const policy = parsed.data;
	if (
		policy.firstPurchaseOffer?.type === "fixed" &&
		policy.firstPurchaseOffer.amount >= product.amount
	)
		throw new APIError("BAD_REQUEST", {
			message: "First purchase price must be below the regular price",
		});
	if (policy.firstPurchaseOffer && discountedAmount(product.amount, policy) < 1)
		throw new APIError("BAD_REQUEST", {
			message: "Purchase discount must leave a positive price",
		});
	return policy;
}
function discountedAmount(amount: number, policy: PurchasePolicy): number {
	const offer = policy.firstPurchaseOffer;
	if (!offer) return amount;
	if (offer.type === "fixed") return offer.amount;
	// Integer minor units, half up; BigInt avoids overflow near MAX_SAFE_INTEGER.
	return Number((BigInt(amount) * BigInt(100 - offer.percentOff) + 50n) / 100n);
}
export function restrictedPurchase(policy: PurchasePolicy): boolean {
	return policy.maxPerUser !== null || policy.firstPurchaseOffer !== null;
}
export async function purchaseQuote<Options extends BetterAuthOptions>(
	db: DBAdapter<Options>,
	referenceId: string,
	product: Product,
): Promise<PurchaseQuote> {
	const policy = purchasePolicy(product);
	const where = [
		{ field: "referenceId", value: referenceId },
		{ field: "productKey", value: product.key },
	];
	const purchaseCount = await db.count({
		model: "businessOrder",
		where: [...where, { field: "paidAt", operator: "ne", value: null }],
	});
	const firstPurchase =
		purchaseCount === 0 && policy.firstPurchaseOffer !== null;
	const amount = firstPurchase
		? discountedAmount(product.amount, policy)
		: product.amount;
	const [pending] = restrictedPurchase(policy)
		? await db.findMany<BusinessOrder>({
				model: "businessOrder",
				where: [
					...where,
					{ field: "paidAt", value: null },
					{ field: "status", value: "pending" },
					{ field: "checkoutClosedAt", value: null },
				],
				sortBy: { field: "createdAt", direction: "asc" },
				limit: 1,
			})
		: [];
	const remaining =
		policy.maxPerUser === null
			? null
			: Math.max(0, policy.maxPerUser - purchaseCount);
	const reason =
		remaining === 0 ? "limit_reached" : pending ? "pending_order" : null;
	return {
		productId: product.id,
		productKey: product.key,
		currency: product.currency,
		baseAmount: product.amount,
		amount,
		discountAmount: product.amount - amount,
		firstPurchase,
		purchaseCount,
		remaining,
		canPurchase: reason === null,
		reason,
		pendingOrderId: pending?.id ?? null,
		quoteVersion: await compositeKey(
			"purchase-quote",
			referenceId,
			product.id,
			String(purchaseCount),
			pending?.id ?? "",
			String(amount),
			JSON.stringify(policy),
		),
	};
}
export async function purchaseConflict<Options extends BetterAuthOptions>(
	db: DBAdapter<Options>,
	order: BusinessOrder,
): Promise<boolean> {
	if (!order.pricing) return false;
	const count = await db.count({
		model: "businessOrder",
		where: [
			{ field: "referenceId", value: order.referenceId },
			{ field: "productKey", value: order.productKey },
			{ field: "id", operator: "ne", value: order.id },
			{ field: "paidAt", operator: "ne", value: null },
		],
	});
	return (
		(order.pricing.policy.maxPerUser !== null &&
			count >= order.pricing.policy.maxPerUser) ||
		(order.pricing.firstPurchase && count > 0)
	);
}
