import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BusinessOrder } from "@app/auth-sdk/business";
import { expect, test } from "@playwright/test";
import { closeAuth, getAuth } from "../lib/auth";

test("payment reports and lifetime spend use real isolated receipts with correct currency and cohort totals", async ({
	page,
	browser,
}) => {
	const keyWarnings: string[] = [];
	page.on("console", (message) => {
		if (message.text().includes("same key")) keyWarnings.push(message.text());
	});
	const auth = getAuth();
	const { adapter } = await auth.$context;
	const suffix = randomUUID();
	const email = `payer-${suffix}@dashboard-e2e.example`;
	const users: string[] = [];
	const orders: string[] = [];
	const ordinaryContext = await browser.newContext({
		baseURL: process.env.BETTER_AUTH_URL,
	});
	try {
		for (const [index, createdAt] of [
			"2025-01-01",
			"2025-01-02",
			"2024-01-01",
		].entries()) {
			const { user } = await auth.api.createUser({
				body: {
					email:
						index === 0
							? email
							: `cohort-${index}-${suffix}@dashboard-e2e.example`,
					name: `Analytics fixture ${index}`,
					password: process.env.DASHBOARD_E2E_PASSWORD!,
					role: "user",
				},
			});
			users.push(user.id);
			await adapter.update({
				model: "user",
				where: [{ field: "id", value: user.id }],
				update: { createdAt: new Date(`${createdAt}T00:00:00Z`) },
			});
		}
		async function receipt(overrides: Partial<BusinessOrder>) {
			// Synthetic verified receipts exist only in this run's isolated SQLite database.
			const row = await adapter.create<Partial<BusinessOrder>, BusinessOrder>({
				model: "businessOrder",
				data: {
					referenceId: users[0]!,
					checkoutKey: randomUUID(),
					provider: "analytics-browser-fixture",
					productId: suffix,
					productKey: suffix,
					product: {} as BusinessOrder["product"],
					amount: 1000,
					currency: "USD",
					status: "fulfilled",
					paymentId: randomUUID(),
					paidAt: new Date("2025-01-02T00:00:00Z"),
					refundedAmount: 0,
					reviewRequired: false,
					createdAt: new Date("2025-01-01T00:00:00Z"),
					expiresAt: new Date("2025-03-01T00:00:00Z"),
					fulfilledAt: new Date("2025-01-02T00:00:00Z"),
					...overrides,
				},
			});
			orders.push(row.id);
			return row;
		}
		await receipt({});
		await receipt({
			amount: 3000,
			refundedAmount: 500,
			status: "partially_refunded",
			paidAt: new Date("2025-01-16T00:00:00Z"),
		});
		await receipt({
			currency: "JPY",
			amount: 500,
			paidAt: new Date("2025-02-01T00:00:00Z"),
		});
		await receipt({
			referenceId: users[2]!,
			amount: 2000,
			refundedAmount: 2000,
			status: "refunded",
		});
		await receipt({
			status: "pending",
			amount: 9000,
			paymentId: null,
			paidAt: null,
		});
		await page.goto("/");
		await page
			.getByLabel("邮箱", { exact: true })
			.fill("admin@dashboard-e2e.example");
		await page
			.getByLabel("密码", { exact: true })
			.fill(process.env.DASHBOARD_E2E_PASSWORD!);
		await page.getByRole("button", { name: "登录", exact: true }).click();
		await page.getByRole("tab", { name: "付款统计", exact: true }).click();
		await page
			.getByLabel("开始日期（UTC）", { exact: true })
			.fill("2025-01-01");
		await page
			.getByLabel("结束日期（UTC，含当天）", { exact: true })
			.fill("2025-02-28");
		await page.getByRole("button", { name: "查询统计", exact: true }).click();
		await expect(page.getByText("50%", { exact: true })).toBeVisible();
		const report = page.getByRole("region", { name: "付款统计", exact: true });
		const usd = report
			.getByRole("table")
			.first()
			.getByRole("row")
			.filter({ hasText: "USD" });
		await expect(usd).toContainText("60.00");
		await expect(usd).toContainText("25.00");
		await expect(usd).toContainText("35.00");
		await expect(usd).toContainText("20.00");
		await report.getByRole("button", { name: "USD", exact: true }).click();
		const monthly = page.waitForResponse(
			(response) =>
				response.url().includes("/business/admin/payment-stats?") &&
				response.url().includes("interval=month"),
		);
		await report.getByRole("button", { name: "按月", exact: true }).click();
		const stats = await (await monthly).json();
		expect(stats).toMatchObject({
			paidOrders: 4,
			paidUsers: 2,
			conversion: { registeredUsers: 2, convertedUsers: 1, rate: 0.5 },
		});
		await expect(
			report.getByRole("cell", { name: "2025-01", exact: true }),
		).toBeVisible();
		await expect(
			report.getByRole("cell", { name: "2025-02", exact: true }),
		).toBeVisible();
		await expect(
			report.getByRole("button", { name: "刷新统计", exact: true }),
		).toBeEnabled();
		await page.screenshot({
			path: resolve(
				process.env.DASHBOARD_E2E_DIRECTORY!,
				"payments-desktop.png",
			),
			fullPage: true,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			),
		).toBeLessThanOrEqual(1);
		await page.screenshot({
			path: resolve(
				process.env.DASHBOARD_E2E_DIRECTORY!,
				"payments-mobile.png",
			),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "切换明暗主题", exact: true })
			.click();
		await page.screenshot({
			path: resolve(process.env.DASHBOARD_E2E_DIRECTORY!, "payments-dark.png"),
			fullPage: true,
		});
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.getByRole("tab", { name: "用户", exact: true }).click();
		await page.getByLabel("搜索用户", { exact: true }).fill(email);
		await page.getByRole("button", { name: "搜索", exact: true }).click();
		await page.getByRole("button", { name: "详情", exact: true }).click();
		const spending = page.getByRole("region", {
			name: "用户累计消费",
			exact: true,
		});
		await expect(spending.getByText(/共 3 笔付款/)).toBeVisible();
		const spendRow = spending.getByRole("row").filter({ hasText: "USD" });
		await expect(spendRow).toContainText("40.00");
		await expect(spendRow).toContainText("5.00");
		await expect(spendRow).toContainText("35.00");
		await page.getByRole("tab", { name: "付款统计", exact: true }).click();
		await page
			.getByLabel("开始日期（UTC）", { exact: true })
			.fill("2023-01-01");
		await page
			.getByLabel("结束日期（UTC，含当天）", { exact: true })
			.fill("2023-01-31");
		await page.getByRole("button", { name: "查询统计", exact: true }).click();
		await expect(
			page.getByText("所选期间暂无已核验收款。", { exact: true }),
		).toBeVisible();
		await page
			.getByLabel("开始日期（UTC）", { exact: true })
			.fill("2025-03-01");
		await page
			.getByLabel("结束日期（UTC，含当天）", { exact: true })
			.fill("2025-01-01");
		await page.getByRole("button", { name: "查询统计", exact: true }).click();
		await expect(report.getByRole("alert")).toContainText("最多 366 天");
		const ordinary = await ordinaryContext.newPage();
		await ordinary.goto("/support");
		await ordinary.getByLabel("邮箱", { exact: true }).fill(email);
		await ordinary
			.getByLabel("密码", { exact: true })
			.fill(process.env.DASHBOARD_E2E_PASSWORD!);
		await ordinary.getByRole("button", { name: "登录", exact: true }).click();
		await expect(
			ordinary.getByRole("heading", { name: "反馈中心", exact: true }),
		).toBeVisible();
		expect(
			(
				await ordinary.request.get(
					"/api/auth/business/admin/payment-stats?from=2025-01-01T00:00:00Z&to=2025-03-01T00:00:00Z",
				)
			).status(),
		).toBe(403);
		expect(
			(await (await ordinary.request.get("/api/auth/business/spending")).json())
				.paidOrders,
		).toBe(3);
		expect(
			(
				await ordinary.request.get(
					`/api/auth/business/spending?referenceId=${users[2]}`,
				)
			).status(),
		).toBe(400);
		expect(keyWarnings).toEqual([]);
	} finally {
		for (const id of orders)
			await adapter.delete({
				model: "businessOrder",
				where: [{ field: "id", value: id }],
			});
		for (const id of users)
			await adapter.delete({
				model: "user",
				where: [{ field: "id", value: id }],
			});
		await ordinaryContext.close();
		await closeAuth();
	}
});
