/** All amounts use ISO minor units; currencies must never be added together. */
export interface PaymentTotals {
	currency: string;
	paidOrders: number;
	paidUsers: number;
	grossAmount: number;
	refundedAmount: number;
	netAmount: number;
	/** Gross amount / paid orders, rounded to the nearest minor unit; null without payments. */
	averageOrderAmount: number | null;
}

/** Revenue grouped by payment date; subsequent refunds restate that payment's bucket. */
export interface BusinessPaymentStatistics {
	generatedAt: Date;
	period: { from: Date; to: Date; interval: "day" | "month"; timezone: "UTC" };
	paidOrders: number;
	paidUsers: number;
	conversion: {
		registeredUsers: number;
		convertedUsers: number;
		rate: number | null;
	};
	currencies: (PaymentTotals & {
		trend: (PaymentTotals & { periodStart: Date })[];
	})[];
}

/** Lifetime verified payments for one user, including subsequently refunded payments. */
export interface BusinessCustomerSpending {
	referenceId: string;
	generatedAt: Date;
	paidOrders: number;
	firstPaidAt: Date | null;
	lastPaidAt: Date | null;
	currencies: PaymentTotals[];
}
