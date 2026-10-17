import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth";
import type * as z from "zod";
import type { BusinessOrder } from "../types";
import type {
	BusinessCustomerSpending,
	BusinessPaymentStatistics,
} from "./types";
import { paymentStatsQuery } from "./validation";

type Receipt = Pick<
	BusinessOrder,
	"id" | "referenceId" | "currency" | "amount" | "refundedAmount" | "paidAt"
>;
const failed = (message: string) =>
	new APIError("SERVICE_UNAVAILABLE", { message });
function safeAdd(left: number, right: number) {
	const value = left + right;
	if (!Number.isSafeInteger(value) || value < 0)
		throw failed("Payment totals exceed the safe integer range");
	return value;
}
function group(currency: string) {
	return {
		currency,
		paidOrders: 0,
		grossAmount: 0,
		refundedAmount: 0,
		users: new Set<string>(),
	};
}
type Group = ReturnType<typeof group>;
function add(target: Group, receipt: Receipt) {
	if (
		!Number.isSafeInteger(receipt.amount) ||
		receipt.amount <= 0 ||
		!Number.isSafeInteger(receipt.refundedAmount) ||
		receipt.refundedAmount < 0 ||
		receipt.refundedAmount > receipt.amount ||
		!/^[A-Z]{3}$/.test(receipt.currency) ||
		!(receipt.paidAt instanceof Date) ||
		!Number.isFinite(receipt.paidAt.getTime())
	)
		throw failed("Invalid verified payment record");
	target.paidOrders++;
	target.grossAmount = safeAdd(target.grossAmount, receipt.amount);
	target.refundedAmount = safeAdd(
		target.refundedAmount,
		receipt.refundedAmount,
	);
	target.users.add(receipt.referenceId);
}
function total(target: Group) {
	const { users, ...result } = target;
	return {
		...result,
		paidUsers: users.size,
		netAmount: result.grossAmount - result.refundedAmount,
		averageOrderAmount: result.paidOrders
			? Number(
					(BigInt(result.grossAmount) + BigInt(result.paidOrders) / 2n) /
						BigInt(result.paidOrders),
				)
			: null,
	};
}
function bucket(date: Date, interval: "day" | "month") {
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			interval === "day" ? date.getUTCDate() : 1,
		),
	);
}

/** Read only verified local receipts; never infer payment from membership or checkout state. */
export function createBusinessAnalyticsService<
	Options extends BetterAuthOptions,
>(adapter: DBAdapter<Options>) {
	async function scan(
		where: Where[],
		now: Date,
		consume: (receipt: Receipt) => void,
	) {
		let cursor = "";
		let count = 0;
		for (;;) {
			const rows = await adapter.findMany<Receipt>({
				model: "businessOrder",
				select: [
					"id",
					"referenceId",
					"currency",
					"amount",
					"refundedAmount",
					"paidAt",
				],
				where: [
					{
						field: "status",
						operator: "in",
						value: ["paid", "fulfilled", "partially_refunded", "refunded"],
					},
					{ field: "paymentId", operator: "ne", value: null },
					{ field: "paymentId", operator: "ne", value: "" },
					{ field: "amount", operator: "gt", value: 0 },
					{ field: "paidAt", operator: "lte", value: now },
					...where,
					...(cursor
						? [{ field: "id", operator: "gt" as const, value: cursor }]
						: []),
				],
				limit: 500,
				sortBy: { field: "id", direction: "asc" },
			});
			count += rows.length;
			// shortcut: adapter-portable reports cap at 100k receipts; use SQL aggregates above this scale.
			if (count > 100_000)
				throw failed(
					"Report exceeds 100000 payments; narrow the period or use database aggregates",
				);
			for (const row of rows) consume(row);
			if (rows.length < 500) break;
			cursor = rows.at(-1)!.id;
		}
	}
	return {
		async payments(
			input: z.input<typeof paymentStatsQuery>,
		): Promise<BusinessPaymentStatistics> {
			const { from, to, interval } = paymentStatsQuery.parse(input);
			const generatedAt = new Date();
			const groups = new Map<
				string,
				{ summary: Group; trend: Map<number, Group> }
			>();
			const users = new Set<string>();
			let paidOrders = 0;
			await scan(
				[
					{ field: "paidAt", operator: "gte", value: from },
					{ field: "paidAt", operator: "lt", value: to },
				],
				generatedAt,
				(receipt) => {
					let value = groups.get(receipt.currency);
					if (!value) {
						value = { summary: group(receipt.currency), trend: new Map() };
						for (let start = bucket(from, interval); start < to; ) {
							value.trend.set(start.getTime(), group(receipt.currency));
							start =
								interval === "day"
									? new Date(start.getTime() + 86_400_000)
									: new Date(
											Date.UTC(
												start.getUTCFullYear(),
												start.getUTCMonth() + 1,
												1,
											),
										);
						}
						groups.set(receipt.currency, value);
					}
					add(value.summary, receipt);
					add(
						value.trend.get(bucket(receipt.paidAt!, interval).getTime())!,
						receipt,
					);
					paidOrders++;
					users.add(receipt.referenceId);
				},
			);
			const registeredWhere: Where[] = [
				{ field: "createdAt", operator: "gte", value: from },
				{ field: "createdAt", operator: "lt", value: to },
				{ field: "createdAt", operator: "lte", value: generatedAt },
			];
			const registeredUsers = await adapter.count({
				model: "user",
				where: registeredWhere,
			});
			let convertedUsers = 0;
			const ids = [...users];
			for (let offset = 0; offset < ids.length; offset += 400)
				convertedUsers += await adapter.count({
					model: "user",
					where: [
						...registeredWhere,
						{
							field: "id",
							operator: "in",
							value: ids.slice(offset, offset + 400),
						},
					],
				});
			if (
				!Number.isSafeInteger(registeredUsers) ||
				registeredUsers < convertedUsers ||
				convertedUsers < 0
			)
				throw failed(
					"User counts changed during reporting; refresh the report",
				);
			return {
				generatedAt,
				period: { from, to, interval, timezone: "UTC" },
				paidOrders,
				paidUsers: users.size,
				conversion: {
					registeredUsers,
					convertedUsers,
					rate: registeredUsers ? convertedUsers / registeredUsers : null,
				},
				currencies: [...groups.values()]
					.sort((a, b) => a.summary.currency.localeCompare(b.summary.currency))
					.map(({ summary, trend }) => ({
						...total(summary),
						trend: [...trend].map(([start, value]) => ({
							periodStart: new Date(start),
							...total(value),
						})),
					})),
			};
		},
		async spending(referenceId: string): Promise<BusinessCustomerSpending> {
			const generatedAt = new Date();
			const groups = new Map<string, Group>();
			let paidOrders = 0;
			let firstPaidAt: Date | null = null;
			let lastPaidAt: Date | null = null;
			await scan(
				[{ field: "referenceId", value: referenceId }],
				generatedAt,
				(receipt) => {
					let value = groups.get(receipt.currency);
					if (!value) {
						value = group(receipt.currency);
						groups.set(receipt.currency, value);
					}
					add(value, receipt);
					paidOrders++;
					if (!firstPaidAt || receipt.paidAt! < firstPaidAt)
						firstPaidAt = receipt.paidAt;
					if (!lastPaidAt || receipt.paidAt! > lastPaidAt)
						lastPaidAt = receipt.paidAt;
				},
			);
			return {
				referenceId,
				generatedAt,
				paidOrders,
				firstPaidAt,
				lastPaidAt,
				currencies: [...groups.values()]
					.sort((a, b) => a.currency.localeCompare(b.currency))
					.map(total),
			};
		},
	};
}
