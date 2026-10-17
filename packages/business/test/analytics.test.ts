import { credits } from "@app/credits";
import { subscription } from "@app/subscription";
import { admin } from "better-auth/plugins/admin";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { business } from "../src";
import { createBusinessAnalyticsService } from "../src/analytics/service";
import { businessClient } from "../src/client";
import type { BusinessOrder } from "../src/types";

const from = "2025-01-01T00:00:00.000Z";
const to = "2025-03-01T00:00:00.000Z";

async function setup() {
	const instance = await getTestInstance(
		{
			plugins: [
				admin({ auditLog: true }),
				subscription({ catalog: true }),
				credits(),
				business(),
			],
			session: { cookieCache: { enabled: true } },
		},
		{ transaction: true, clientOptions: { plugins: [businessClient()] } },
	);
	const { user, headers } = await instance.signInWithTestUser();
	const { adapter } = await instance.auth.$context;
	await adapter.update({
		model: "user",
		where: [{ field: "id", value: user.id }],
		update: { createdAt: new Date(from) },
	});
	async function receipt(overrides: Partial<BusinessOrder> = {}) {
		// Explicit synthetic receipts exercise real SQL reads, not a payment-provider integration.
		return adapter.create<Partial<BusinessOrder>, BusinessOrder>({
			model: "businessOrder",
			data: {
				referenceId: user.id,
				checkoutKey: crypto.randomUUID(),
				provider: "analytics-test",
				productId: "analytics-fixture",
				productKey: "analytics-fixture",
				product: {} as BusinessOrder["product"],
				amount: 1000,
				currency: "USD",
				status: "fulfilled",
				paymentId: crypto.randomUUID(),
				paidAt: new Date("2025-01-02T12:00:00Z"),
				refundedAmount: 0,
				reviewRequired: false,
				createdAt: new Date(from),
				expiresAt: new Date(to),
				fulfilledAt: new Date(from),
				...overrides,
			},
		});
	}
	const promote = () =>
		adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "admin" },
		});
	return {
		...instance,
		user,
		headers,
		adapter,
		receipt,
		promote,
		analytics: createBusinessAnalyticsService(adapter),
	};
}

describe("verified payment analytics", () => {
	it("separates currencies, deduplicates payers, includes refunds and zero-fills UTC day/month trends", async () => {
		const { analytics, receipt, adapter, user } = await setup();
		const other = await adapter.create({
			model: "user",
			data: {
				name: "Old customer",
				email: "old@analytics.example",
				emailVerified: true,
				createdAt: new Date("2024-01-01Z"),
				updatedAt: new Date(),
			},
		});
		await receipt();
		await receipt({
			amount: 2000,
			refundedAmount: 500,
			status: "partially_refunded",
			paidAt: new Date("2025-02-02T00:00:00Z"),
		});
		await receipt({
			referenceId: other.id,
			amount: 500,
			refundedAmount: 500,
			status: "refunded",
		});
		await receipt({ currency: "JPY", amount: 300 });
		await receipt({ paidAt: new Date("2024-12-31T23:59:59.999Z") });
		await receipt({ paidAt: new Date(to) });
		await receipt({ status: "pending" });
		await receipt({ paymentId: null });
		await receipt({ amount: 0 });
		const stats = await analytics.payments({ from, to, interval: "month" });
		expect(stats).toMatchObject({
			paidOrders: 4,
			paidUsers: 2,
			conversion: { registeredUsers: 1, convertedUsers: 1, rate: 1 },
		});
		expect(stats.currencies.map((entry) => entry.currency)).toEqual([
			"JPY",
			"USD",
		]);
		expect(stats.currencies[1]).toMatchObject({
			grossAmount: 3500,
			refundedAmount: 1000,
			netAmount: 2500,
			averageOrderAmount: 1167,
			paidUsers: 2,
			paidOrders: 3,
		});
		expect(
			stats.currencies[1]!.trend.map(
				({ periodStart, grossAmount, netAmount }) => [
					periodStart.toISOString(),
					grossAmount,
					netAmount,
				],
			),
		).toEqual([
			[from, 1500, 1000],
			["2025-02-01T00:00:00.000Z", 2000, 1500],
		]);
		const daily = await analytics.payments({
			from,
			to: "2025-01-04T00:00:00Z",
		});
		expect(daily.currencies[1]!.trend.map((item) => item.paidOrders)).toEqual([
			0, 2, 0,
		]);
		expect(daily.currencies[1]!.trend[0]!.averageOrderAmount).toBeNull();
		expect(
			(await analytics.spending(user.id)).currencies.find(
				(item) => item.currency === "USD",
			)!.grossAmount,
		).toBe(5000);
	});

	it("calculates conversion from current registration cohorts and never divides by zero", async () => {
		const { analytics, adapter, receipt, user } = await setup();
		await adapter.create({
			model: "user",
			data: {
				name: "Unpaid",
				email: "unpaid@analytics.example",
				emailVerified: false,
				createdAt: new Date(from),
				updatedAt: new Date(),
			},
		});
		await receipt({ paidAt: new Date(from) });
		await receipt({ paidAt: new Date(from) });
		expect((await analytics.payments({ from, to })).conversion).toEqual({
			registeredUsers: 2,
			convertedUsers: 1,
			rate: 0.5,
		});
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { createdAt: new Date("2024-01-01Z") },
		});
		const empty = await analytics.payments({
			from: "2024-02-01T00:00:00Z",
			to: "2024-03-01T00:00:00Z",
		});
		expect(empty).toMatchObject({
			paidOrders: 0,
			paidUsers: 0,
			currencies: [],
			conversion: { rate: null },
		});
		expect(await analytics.spending("no-receipts")).toMatchObject({
			paidOrders: 0,
			firstPaidAt: null,
			lastPaidAt: null,
			currencies: [],
		});
	});

	it("reads all pages and rejects unsafe or inconsistent stored amounts", async () => {
		const { analytics, receipt, adapter, user } = await setup();
		for (let count = 0; count < 501; count++) await receipt({ amount: 1 });
		expect((await analytics.spending(user.id)).currencies[0]).toMatchObject({
			paidOrders: 501,
			grossAmount: 501,
			averageOrderAmount: 1,
		});
		const invalid = await receipt({ amount: 1, refundedAmount: 2 });
		await expect(analytics.spending(user.id)).rejects.toThrow(
			"Invalid verified payment",
		);
		await adapter.delete({
			model: "businessOrder",
			where: [{ field: "id", value: invalid.id }],
		});
		await receipt({ amount: Number.MAX_SAFE_INTEGER });
		await expect(analytics.spending(user.id)).rejects.toThrow(
			"safe integer range",
		);
	});

	it("excludes future payments and accepts UTC offset instants with exclusive end boundaries", async () => {
		const { analytics, receipt, user } = await setup();
		await receipt({ paidAt: new Date(Date.now() + 86_400_000) });
		await receipt({ paidAt: new Date(from) });
		const stats = await analytics.payments({
			from: "2025-01-01T08:00:00+08:00",
			to: "2025-01-02T08:00:00+08:00",
		});
		expect(stats.paidOrders).toBe(1);
		expect(stats.currencies[0]!.trend[0]!.periodStart.toISOString()).toBe(from);
		expect((await analytics.spending(user.id)).paidOrders).toBe(1);
		await expect(
			analytics.payments({ from, to: "2027-01-01T00:00:00Z" }),
		).rejects.toThrow("366 days");
		await expect(analytics.payments({ from: to, to: from })).rejects.toThrow();
	});

	it("enforces fresh permissions, private own-user queries and typed browser responses", async () => {
		const { auth, client, receipt, promote, headers, user, adapter } =
			await setup();
		await receipt();
		const query = { from, to, interval: "month" as const };
		const fetchOptions = { headers, throw: true as const };
		expect(
			(
				await client.business.admin.paymentStats({
					query,
					fetchOptions: { headers },
				})
			).error?.status,
		).toBe(403);
		expect((await client.business.spending()).error?.status).toBe(401);
		const own = await client.business.spending({ fetchOptions });
		expect(own.referenceId).toBe(user.id);
		expect(own.firstPaidAt).toBeInstanceOf(Date);
		expect(
			(
				await client.$fetch("/business/spending?referenceId=someone-else", {
					headers,
				})
			).error?.status,
		).toBe(400);
		await promote();
		const stats = await client.business.admin.paymentStats({
			query,
			fetchOptions,
		});
		expect(stats.currencies[0]!.grossAmount).toBe(1000);
		expect(stats.period.from).toBeInstanceOf(Date);
		expect(stats.currencies[0]!.trend[0]!.periodStart).toBeInstanceOf(Date);
		expect(
			(
				await client.business.admin.spending({
					query: { referenceId: user.id },
					fetchOptions,
				})
			).paidOrders,
		).toBe(1);
		const response = await auth.handler(
			new Request(
				`http://localhost:3000/api/auth/business/admin/payment-stats?${new URLSearchParams(query)}`,
				{ headers },
			),
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "user" },
		});
		expect(
			(
				await client.business.admin.paymentStats({
					query,
					fetchOptions: { headers },
				})
			).error?.status,
		).toBe(403);
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { banned: true },
		});
		expect(
			(await client.business.spending({ fetchOptions: { headers } })).error
				?.status,
		).toBe(403);
	});
});
