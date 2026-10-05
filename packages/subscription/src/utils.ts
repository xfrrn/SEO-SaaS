import type {
	Subscription,
	SubscriptionPlan,
	SubscriptionPlans,
} from "./types";

/** Resolve static or asynchronously supplied plans without changing their type. */
export async function resolvePlans<T extends SubscriptionPlan>(
	plans: SubscriptionPlans<T>,
): Promise<T[]> {
	return typeof plans === "function" ? await plans() : plans;
}

/** Check status only; payment adapters can preserve their existing semantics. */
export function isActiveOrTrialing(subscription: { status: string }): boolean {
	return subscription.status === "active" || subscription.status === "trialing";
}

/** Check status and absolute dates before granting subscription entitlements. */
export function isSubscriptionActive(
	subscription: Pick<
		Subscription,
		| "status"
		| "periodStart"
		| "periodEnd"
		| "trialStart"
		| "trialEnd"
		| "cancelAt"
		| "endedAt"
	>,
	now = new Date(),
): boolean {
	if (!isActiveOrTrialing(subscription)) return false;
	const time = now.getTime();
	const start = subscription.periodStart?.getTime();
	const end = subscription.periodEnd?.getTime();
	if (
		!Number.isFinite(time) ||
		start === undefined ||
		end === undefined ||
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start > time ||
		end <= time
	) {
		return false;
	}
	for (const cutoff of [subscription.cancelAt, subscription.endedAt]) {
		if (
			cutoff &&
			(!Number.isFinite(cutoff.getTime()) || cutoff.getTime() <= time)
		) {
			return false;
		}
	}
	if (subscription.status === "trialing") {
		if (
			subscription.trialStart &&
			!(subscription.trialStart.getTime() <= time)
		) {
			return false;
		}
		if (subscription.trialEnd && !(subscription.trialEnd.getTime() > time)) {
			return false;
		}
	}
	return true;
}
