/** A payment-provider-independent plan and its application-defined limits. */
export interface SubscriptionPlan {
	name: string;
	limits?: Record<string, unknown> | undefined;
	group?: string | undefined;
}

/** Plans may be loaded from application configuration or persistent storage. */
export type SubscriptionPlans<T extends SubscriptionPlan = SubscriptionPlan> =
	| T[]
	| (() => T[] | Promise<T[]>);

/** A subscription's shared lifecycle, independent of its payment provider. */
export interface Subscription {
	id: string;
	plan: string;
	referenceId: string;
	status:
		| "active"
		| "canceled"
		| "incomplete"
		| "incomplete_expired"
		| "past_due"
		| "paused"
		| "trialing"
		| "unpaid";
	periodStart?: Date | undefined;
	periodEnd?: Date | undefined;
	trialStart?: Date | undefined;
	trialEnd?: Date | undefined;
	cancelAtPeriodEnd?: boolean | undefined;
	cancelAt?: Date | undefined;
	canceledAt?: Date | undefined;
	endedAt?: Date | undefined;
	groupId?: string | undefined;
	seats?: number | undefined;
	billingInterval?: "day" | "week" | "month" | "year" | undefined;
	/** Provider identifiers are nullable for subscriptions created before extraction. */
	provider?: string | null | undefined;
	providerSubscriptionId?: string | null | undefined;
	providerCustomerId?: string | null | undefined;
	/** Monotonic revision supplied by a trusted synchronization caller. */
	revision?: number | null | undefined;
	/** Internal unique key for the provider and its subscription identifier. */
	syncKey?: string | null | undefined;
}
