import { resolvePlans } from "@app/subscription/utils";
import type { AuthContext } from "@better-auth/core";
import type { Where } from "@better-auth/core/db/adapter";
import type Stripe from "stripe";
import type { StripeOptions, StripePlan, Subscription } from "./types";

export { isActiveOrTrialing } from "@app/subscription/utils";

export async function getPlans(
	subscriptionOptions: StripeOptions["subscription"],
) {
	if (subscriptionOptions?.enabled) {
		return resolvePlans(subscriptionOptions.plans);
	}
	throw new Error("Subscriptions are not enabled in the Stripe options.");
}

export async function getPlanByName(options: StripeOptions, name: string) {
	return await getPlans(options.subscription).then((res) =>
		res?.find((plan) => plan.name.toLowerCase() === name.toLowerCase()),
	);
}

/** Recognize Stripe rows, including records created before provider tracking. */
export function isStripeSubscription(
	sub: Pick<Subscription, "provider">,
): boolean {
	return sub.provider == null || sub.provider === "stripe";
}

/** Scope provider reads before pagination, retaining legacy unmarked Stripe rows. */
export function stripeSubscriptionWhere(
	context: Pick<AuthContext, "tables">,
	where: (Where & { connector?: "AND" })[],
): Where[] {
	if (!context.tables.subscription?.fields.provider) return where;
	// OR clauses must precede the AND constraints: SQL groups them, while the
	// memory adapter evaluates clauses in order.
	return [
		{ field: "provider", value: "stripe", connector: "OR" },
		{ field: "provider", value: null, connector: "OR" },
		...where,
	];
}

/** Ignore another provider's row when resolving an explicit Stripe identifier. */
export function onlyStripeSubscription<
	T extends Pick<Subscription, "provider">,
>(sub: T | null): T | null {
	return sub && isStripeSubscription(sub) ? sub : null;
}

/** Add provider-neutral identifiers only when the subscription plugin owns them. */
export function stripeSubscriptionData(
	context: Pick<AuthContext, "tables">,
	sub: Pick<Subscription, "stripeSubscriptionId" | "stripeCustomerId">,
) {
	if (!context.tables.subscription?.fields.provider) return {};
	return {
		provider: "stripe",
		...(sub.stripeSubscriptionId
			? {
					providerSubscriptionId: sub.stripeSubscriptionId,
					syncKey: JSON.stringify(["stripe", sub.stripeSubscriptionId]),
				}
			: {}),
		...(sub.stripeCustomerId
			? { providerCustomerId: sub.stripeCustomerId }
			: {}),
	};
}

/**
 * Check if a subscription is scheduled to be canceled (DB subscription object)
 */
export function isPendingCancel(sub: Subscription): boolean {
	return !!(sub.cancelAtPeriodEnd || sub.cancelAt);
}

/**
 * Check if a Stripe subscription is scheduled to be canceled (Stripe API response)
 */
export function isStripePendingCancel(stripeSub: Stripe.Subscription): boolean {
	return !!(stripeSub.cancel_at_period_end || stripeSub.cancel_at);
}

/**
 * Escapes a value for use in Stripe search queries.
 * Stripe search query uses backslash escaping inside double-quoted
 * string values, so literal backslashes must be escaped before quotes.
 *
 * @see https://docs.stripe.com/search#search-query-language
 */
export function escapeStripeSearchValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Resolve the quantity for a subscription by checking the seat item first,
 * then falling back to the plan item's quantity.
 */
export function resolveQuantity(
	items: Stripe.SubscriptionItem[],
	planItem: Stripe.SubscriptionItem,
	seatPriceId?: string,
): number {
	if (seatPriceId) {
		const seatItem = items.find((item) => item.price.id === seatPriceId);
		if (seatItem) return seatItem.quantity ?? 1;
	}
	return planItem.quantity ?? 1;
}

/**
 * Resolve the plan-matching subscription item and its plan config
 * from a (possibly multi-item) Stripe subscription.
 *
 * - Iterates items to find one whose price matches a configured plan.
 * - For single-item subscriptions, returns the item even without a plan match.
 */
export async function resolvePlanItem(
	options: StripeOptions,
	items: Stripe.SubscriptionItem[],
): Promise<
	{ item: Stripe.SubscriptionItem; plan: StripePlan | undefined } | undefined
> {
	const first = items[0];
	if (!first) return undefined;
	const plans = await getPlans(options.subscription);
	for (const item of items) {
		const plan = plans?.find(
			(p) =>
				p.priceId === item.price.id ||
				p.annualDiscountPriceId === item.price.id ||
				(item.price.lookup_key &&
					(p.lookupKey === item.price.lookup_key ||
						p.annualDiscountLookupKey === item.price.lookup_key)),
		);
		if (plan) return { item, plan };
	}
	return items.length === 1 ? { item: first, plan: undefined } : undefined;
}
