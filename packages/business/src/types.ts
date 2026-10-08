import type { Product } from "@app/subscription";
import type { Session, User } from "better-auth";

/** JSON-persisted responses preserve dates as ISO strings, including on idempotent replay. */
export type BusinessJSON<T> = T extends Date
	? string
	: T extends readonly (infer Item)[]
		? BusinessJSON<Item>[]
		: T extends object
			? { [Key in keyof T]: BusinessJSON<T[Key]> }
			: T;

/** Immutable purchase details plus the locally reconciled payment/fulfillment state. */
export interface BusinessOrder {
	id: string;
	referenceId: string;
	checkoutKey: string;
	provider: string;
	productId: string;
	productKey: string;
	parentOrderId: string | null;
	product: BusinessJSON<Product>;
	amount: number;
	currency: string;
	status: "pending" | "paid" | "fulfilled" | "partially_refunded" | "refunded";
	providerOrderId: string | null;
	providerKey: string | null;
	checkoutURL: string | null;
	paymentId: string | null;
	paidAt: Date | null;
	periodStart: Date | null;
	periodEnd: Date | null;
	refundedAmount: number;
	reviewRequired: boolean;
	createdAt: Date;
	expiresAt: Date;
	fulfilledAt: Date | null;
}

/** Returned only after a server-side provider query/signature and ownership verification. */
export interface VerifiedPayment {
	paymentId: string;
	providerOrderId: string;
	amount: number;
	currency: string;
	paidAt: Date;
	/** Absolute billing periods, for already-supported recurring payment integrations. */
	periodStart?: Date;
	periodEnd?: Date;
}

/** One completed refund, never a browser assertion or an unverified webhook body. */
export interface VerifiedRefund {
	refundId: string;
	paymentId: string;
	amount: number;
	currency: string;
	refundedAt: Date;
}

/** Adapt an existing payment integration; no recurring-charge or refund initiation API is added. */
export interface BusinessPaymentProvider {
	/** Reuse order.id as the provider idempotency key. Values come from the persisted order. */
	createCheckout(order: BusinessOrder): Promise<{
		providerOrderId: string;
		url: string;
	}>;
	/** Query/verify the provider and return only a completed payment belonging to this checkout. */
	verifyPayment(input: {
		order: BusinessOrder;
		reference: string;
	}): Promise<VerifiedPayment>;
	/** Verify a completed refund using an existing provider API or verified delivery. */
	verifyRefund?: (input: {
		order: BusinessOrder;
		reference: string;
	}) => Promise<VerifiedRefund>;
}

/** Administrative actions authorized on the server before any read or write. */
export type BusinessPermission =
	| "catalog:read"
	| "catalog:write"
	| "orders:read"
	| "orders:retry"
	| "customers:read"
	| "credits:adjust"
	| "membership:adjust"
	| "audit:read"
	| "metrics:read";

/** Configure existing payment integrations and optional delegated operator permissions. */
export interface BusinessOptions {
	providers?: Record<string, BusinessPaymentProvider>;
	/** Default 30 minutes; affects new payment attempts, never discards verified late payments. */
	orderTtlMs?: number;
	/** Omit for adminRoles/adminUserIds only. Return true only for the requested action. */
	authorize?: (input: {
		user: User;
		session: Session;
		permission: BusinessPermission;
	}) => boolean | Promise<boolean>;
}
