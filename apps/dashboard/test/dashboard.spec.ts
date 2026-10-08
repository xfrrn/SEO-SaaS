import { resolve } from "node:path";
import { createBusinessService } from "@app/auth-sdk/business";
import { createCreditsService } from "@app/auth-sdk/credits";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { closeAuth, getAuth } from "../lib/auth";

const customerEmail = "created@dashboard-e2e.example";
const productName = "验收月度会员";

async function login(page: Page, role: "admin" | "user" = "admin") {
	await page.goto("/");
	await page
		.getByLabel("邮箱", { exact: true })
		.fill(`${role}@dashboard-e2e.example`);
	await page
		.getByLabel("密码", { exact: true })
		.fill(process.env.DASHBOARD_E2E_PASSWORD!);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	if (role === "admin")
		await expect(
			page.getByRole("heading", { name: "管理后台", exact: true }),
		).toBeVisible();
}

async function selectUser(page: Page) {
	await page.getByLabel("查找用户", { exact: true }).fill(customerEmail);
	await page.getByRole("button", { name: "搜索", exact: true }).click();
	await page.getByRole("button", { name: "选择", exact: true }).click();
}

async function noPageOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth,
		),
	).toBeLessThanOrEqual(1);
}

async function screenshot(page: Page, name: string) {
	await page.screenshot({
		path: resolve(process.env.DASHBOARD_E2E_DIRECTORY!, `${name}.png`),
		fullPage: true,
	});
}

test.describe("real SDK dashboard", () => {
	test("anonymous and ordinary users cannot read or mutate admin data", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByText("登录管理后台", { exact: true })).toBeVisible();
		for (const path of [
			"/business/admin/overview",
			"/business/admin/orders",
			"/admin/list-users",
		]) {
			expect((await page.request.get(`/api/auth${path}`)).status()).toBe(401);
		}
		await login(page, "user");
		await expect(page.getByText("后台访问", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("alert").filter({ hasText: "Not allowed" }),
		).toBeVisible();
		await expect(page.getByRole("tablist")).toHaveCount(0);
		for (const path of [
			"/business/admin/overview",
			"/business/admin/orders",
			"/business/admin/audit",
			"/admin/list-users",
		]) {
			expect((await page.request.get(`/api/auth${path}`)).status()).toBe(403);
		}
		const rejected = await page.request.post(
			"/api/auth/business/admin/credits/adjust",
			{
				headers: { origin: process.env.BETTER_AUTH_URL! },
				data: {
					referenceId: process.env.DASHBOARD_E2E_USER_ID,
					operationId: "denied-adjustment",
					action: "grant",
					amount: 1,
					reason: "permission check",
				},
			},
		);
		expect(rejected.status()).toBe(403);
		const { adapter } = await getAuth().$context;
		expect(
			(
				await createCreditsService(adapter).balance(
					process.env.DASHBOARD_E2E_USER_ID!,
				)
			).balance,
		).toBe(0);
		await closeAuth();
	});

	test("administrator manages real users, products, credits, memberships and audit", async ({
		page,
	}) => {
		await login(page);
		await expect(page.getByText("支付未配置 · 保留已记录历史")).toBeVisible();
		await noPageOverflow(page);
		await screenshot(page, "desktop-overview");
		await page.setViewportSize({ width: 390, height: 844 });
		await noPageOverflow(page);
		await screenshot(page, "mobile-overview");
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.getByRole("tab", { name: "订单", exact: true }).click();
		await expect(page.getByText("没有符合筛选条件的订单。")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "重试履约", exact: true }),
		).toHaveCount(0);

		await page.getByRole("tab", { name: "用户", exact: true }).click();
		await page.getByRole("button", { name: "新建用户", exact: true }).click();
		let dialog = page.getByRole("dialog");
		await dialog.getByLabel("姓名", { exact: true }).fill("验收新用户");
		await dialog.getByLabel("邮箱", { exact: true }).fill(customerEmail);
		await dialog.getByRole("button", { name: "创建用户", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByRole("status").filter({ hasText: "用户已创建" }),
		).toBeVisible();
		await page.getByLabel("搜索用户", { exact: true }).fill(customerEmail);
		await page.getByRole("button", { name: "搜索", exact: true }).click();
		await expect(
			page.getByRole("row").filter({ hasText: customerEmail }),
		).toHaveCount(1);
		await page.getByRole("button", { name: "详情", exact: true }).click();
		await expect(page.getByText("该用户当前没有登录会话。")).toBeVisible();

		await page.getByRole("tab", { name: "套餐", exact: true }).click();
		await page.getByRole("button", { name: "新增套餐", exact: true }).click();
		await page.getByLabel("套餐标识", { exact: true }).fill("e2e-monthly");
		await page.getByLabel("套餐名称", { exact: true }).fill(productName);
		await page.getByLabel("价格", { exact: true }).fill("9.99");
		await page.getByLabel("操作原因", { exact: true }).fill("E2E 创建会员套餐");
		await page.getByRole("button", { name: "保存套餐", exact: true }).click();
		const product = page.getByRole("row").filter({ hasText: productName });
		await expect(product).toContainText("已下架");
		await product.getByRole("button", { name: /^上架/ }).click();
		dialog = page.getByRole("dialog");
		await dialog
			.getByLabel("操作原因", { exact: true })
			.fill("E2E 上架会员套餐");
		await dialog.getByRole("button", { name: "确认上架", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(product).toContainText("已上架");

		await page.getByRole("tab", { name: "积分", exact: true }).click();
		await selectUser(page);
		await page.getByRole("button", { name: "发放积分", exact: true }).click();
		dialog = page.getByRole("dialog");
		await dialog.getByLabel("积分数量", { exact: true }).fill("100");
		await dialog
			.getByLabel("操作原因", { exact: true })
			.fill("E2E 手动发放积分");
		const adjustmentURL = "**/api/auth/business/admin/credits/adjust";
		let originalOperationId = "";
		await page.route(
			adjustmentURL,
			async (route) => {
				const body = route.request().postDataJSON() as {
					operationId: string;
				};
				originalOperationId = body.operationId;
				const response = await route.fetch();
				expect(response.ok()).toBe(true);
				// The write commits, but its response is lost before reaching the client.
				await route.abort("failed");
			},
			{ times: 1 },
		);
		await dialog.getByRole("button", { name: "确认发放", exact: true }).click();
		await expect(dialog.getByRole("alert")).toBeVisible();
		await page.unroute(adjustmentURL);
		await dialog.getByRole("button", { name: "返回", exact: true }).click();
		await page.getByRole("button", { name: "发放积分", exact: true }).click();
		dialog = page.getByRole("dialog");
		await dialog.getByLabel("积分数量", { exact: true }).fill("100");
		await dialog
			.getByLabel("操作原因", { exact: true })
			.fill("E2E 手动发放积分");
		const replayRequest = page.waitForRequest((request) =>
			request.url().endsWith("/business/admin/credits/adjust"),
		);
		await dialog.getByRole("button", { name: "确认发放", exact: true }).click();
		expect((await replayRequest).postDataJSON()).toMatchObject({
			operationId: originalOperationId,
		});
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByRole("row").filter({ hasText: "E2E 手动发放积分" }),
		).toContainText("+100");
		await page.getByRole("button", { name: "扣减积分", exact: true }).click();
		dialog = page.getByRole("dialog");
		await dialog.getByLabel("积分数量", { exact: true }).fill("25");
		await dialog
			.getByLabel("操作原因", { exact: true })
			.fill("E2E 手动扣减积分");
		await dialog.getByRole("button", { name: "确认扣减", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		const debit = page.getByRole("row").filter({ hasText: "E2E 手动扣减积分" });
		await expect(debit).toContainText("-25");
		await expect(debit).toContainText("75");

		await page.getByRole("tab", { name: "会员", exact: true }).click();
		await page.getByRole("button", { name: "开通会员", exact: true }).click();
		await selectUser(page);
		dialog = page.getByRole("dialog");
		await dialog
			.getByLabel("会员商品", { exact: true })
			.selectOption({ label: `${productName} · v2` });
		await dialog
			.getByLabel("操作原因", { exact: true })
			.fill("E2E 手动开通会员");
		await dialog.getByRole("button", { name: "确认开通", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByRole("row").filter({ hasText: "business" }),
		).toContainText("生效中");
		await page.getByRole("button", { name: "取消会员", exact: true }).click();
		dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("已发放积分不会随之清空");
		await dialog
			.getByLabel("操作原因", { exact: true })
			.fill("E2E 手动取消会员");
		await dialog
			.getByRole("button", { name: "确认取消会员", exact: true })
			.click();
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByRole("row").filter({ hasText: "business" }),
		).toContainText("已取消");
		await page.getByRole("tab", { name: "审计", exact: true }).click();
		await expect(
			page
				.getByRole("row")
				.filter({ hasText: "E2E 手动取消会员" })
				.filter({ hasText: "成功" }),
		).toBeVisible();
		await noPageOverflow(page);
		await screenshot(page, "desktop-audit");

		await page.setViewportSize({ width: 390, height: 844 });
		for (const name of ["概览", "用户", "套餐", "订单", "会员", "审计"]) {
			await page.getByRole("tab", { name, exact: true }).click();
			await expect(page.getByRole("status", { name: "正在加载" })).toHaveCount(
				0,
			);
			await noPageOverflow(page);
			if (name === "会员") {
				const membershipRow = page
					.getByRole("row")
					.filter({ hasText: "business" });
				await expect(membershipRow).toBeVisible();
				expect((await membershipRow.boundingBox())!.height).toBeLessThan(250);
				expect(
					(await page.getByRole("table").boundingBox())!.width,
				).toBeGreaterThanOrEqual(768);
			}
		}
		await page.getByRole("tab", { name: "概览", exact: true }).click();
		await page.getByRole("button", { name: "切换明暗主题" }).click();
		await expect(page.locator("html")).toHaveClass(/dark/);
		await screenshot(page, "mobile-dark");
		await page.getByRole("tab", { name: "会员", exact: true }).click();
		await page.getByRole("button", { name: "开通会员", exact: true }).click();
		dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveClass(/data-\[state=open\]:animate-in/);
		expect(
			await dialog.evaluate((element) =>
				element.contains(document.activeElement),
			),
		).toBe(true);
		expect(
			await dialog.evaluate((element) => getComputedStyle(element).overflowY),
		).toBe("auto");
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(844 * 0.9 + 1);
		await noPageOverflow(page);
		await screenshot(page, "mobile-membership-dialog");
		await page.emulateMedia({ reducedMotion: "reduce" });
		expect(
			await dialog.evaluate((element) =>
				Number.parseFloat(getComputedStyle(element).animationDuration),
			),
		).toBeLessThanOrEqual(0.001);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
	});

	test("pending orders cannot retry; verified paid fulfillment can retry exactly once", async ({
		page,
	}) => {
		const auth = getAuth();
		const { adapter } = await auth.$context;
		const service = createBusinessService(
			adapter,
			{ catalog: true },
			{
				providers: {
					test: {
						createCheckout: async (order) => ({
							providerOrderId: `test-${order.id}`,
							url: `https://payments.example/${order.id}`,
						}),
						verifyPayment: async ({ order }) => ({
							providerOrderId: `test-${order.id}`,
							paymentId: `payment-${order.id}`,
							amount: order.amount,
							currency: order.currency,
							paidAt: new Date(),
						}),
					},
				},
			},
		);
		const product = await service.products.save({
			key: "e2e-retry",
			name: "验收重试积分包",
			type: "credits",
			amount: 100,
			currency: "USD",
			credits: 10,
			membershipDays: null,
			creditValidityDays: null,
			limits: {},
			published: true,
			expectedVersion: 0,
		});
		const referenceId = process.env.DASHBOARD_E2E_USER_ID!;
		const pending = await service.createOrder(referenceId, {
			productId: product.id,
			provider: "test",
			idempotencyKey: "pending-order",
		});
		const paid = await service.createOrder(referenceId, {
			productId: product.id,
			provider: "test",
			idempotencyKey: "paid-order",
		});
		await service.checkout(referenceId, paid.id);
		const database = new Database(process.env.DASHBOARD_SQLITE_PATH!);
		try {
			// A test-only SQLite failure leaves the real SDK's verified payment pending fulfillment.
			database.exec(
				"CREATE TRIGGER e2e_ledger_outage BEFORE INSERT ON creditEntry BEGIN SELECT RAISE(ABORT, 'E2E ledger outage'); END",
			);
			await expect(
				service.confirmPayment(paid.id, "test-payment"),
			).rejects.toThrow("E2E ledger outage");
		} finally {
			database.exec("DROP TRIGGER IF EXISTS e2e_ledger_outage");
			database.close();
		}
		expect((await service.getOrder(paid.id)).status).toBe("paid");
		await closeAuth();
		await login(page);
		await page.getByRole("tab", { name: "订单", exact: true }).click();
		await page
			.getByRole("button", { name: `查看详情 ${pending.id}`, exact: true })
			.click();
		await expect(page.getByRole("dialog")).toContainText("待付款");
		await expect(
			page.getByRole("button", { name: "重试履约", exact: true }),
		).toHaveCount(0);
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: `查看详情 ${paid.id}`, exact: true })
			.click();
		await page.getByRole("button", { name: "重试履约", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("履约已完成");
		await expect(
			page.getByRole("button", { name: "重试履约", exact: true }),
		).toHaveCount(0);
		const replay = await page.request.post(
			"/api/auth/business/admin/orders/retry",
			{
				headers: { origin: process.env.BETTER_AUTH_URL! },
				data: { orderId: paid.id },
			},
		);
		expect(replay.ok()).toBe(true);
		const fresh = await getAuth().$context;
		expect(
			(await createCreditsService(fresh.adapter).balance(referenceId)).balance,
		).toBe(10);
		await closeAuth();
		await screenshot(page, "desktop-order-retried");
		await page.keyboard.press("Escape");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.getByRole("tab", { name: "概览", exact: true }).click();
		await expect(page.getByRole("img", { name: /待付款 1 笔/ })).toBeVisible();
		await screenshot(page, "desktop-overview-populated");
	});
});
