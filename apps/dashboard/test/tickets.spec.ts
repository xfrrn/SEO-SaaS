import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { closeAuth, getAuth } from "../lib/auth";

async function login(page: Page, path: string, email: string) {
	await page.goto(path);
	await page.getByLabel("邮箱", { exact: true }).fill(email);
	await page
		.getByLabel("密码", { exact: true })
		.fill(process.env.DASHBOARD_E2E_PASSWORD!);
	await page.getByRole("button", { name: "登录", exact: true }).click();
}

test("customers and administrators complete real isolated feedback conversations", async ({
	page,
	browser,
}) => {
	const title = `反馈回归 ${randomUUID().slice(0, 8)}`;
	const content =
		"无法查看我的付款记录。<img src=not-a-real-image onerror=alert(1)>";
	const adminContext = await browser.newContext({
		baseURL: process.env.BETTER_AUTH_URL,
	});
	const otherContext = await browser.newContext({
		baseURL: process.env.BETTER_AUTH_URL,
	});
	const manager = await adminContext.newPage();
	const other = await otherContext.newPage();
	const otherEmail = `ticket-other-${randomUUID()}@dashboard-e2e.example`;
	try {
		await getAuth().api.createUser({
			body: {
				email: otherEmail,
				name: "工单隔离用户",
				password: process.env.DASHBOARD_E2E_PASSWORD!,
				role: "user",
			},
		});
		expect((await page.request.get("/api/auth/tickets/list")).status()).toBe(
			401,
		);
		await login(page, "/support", "user@dashboard-e2e.example");
		await expect(
			page.getByRole("heading", { name: "反馈中心", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("暂无工单，点击“新建工单”提交反馈。"),
		).toBeVisible();
		await page.getByRole("button", { name: "新建工单", exact: true }).click();
		await page.getByLabel("工单标题", { exact: true }).fill(title);
		await page.getByLabel("问题描述", { exact: true }).fill(content);
		const created = page.waitForResponse((response) =>
			response.url().endsWith("/api/auth/tickets/create"),
		);
		await page.getByRole("button", { name: "提交工单", exact: true }).click();
		const { ticket } = await (await created).json();
		await expect(page.getByText(content, { exact: true })).toBeVisible();
		expect(await page.locator("img[src='not-a-real-image']").count()).toBe(0);
		await page.getByLabel("追加回复").fill("补充：刷新页面后仍然出现。 ");
		await page.getByRole("button", { name: "发送回复", exact: true }).click();
		await expect(
			page.getByText("补充：刷新页面后仍然出现。", { exact: true }),
		).toBeVisible();
		expect(
			(await page.request.get("/api/auth/tickets/admin/list")).status(),
		).toBe(403);
		expect(
			(
				await page.request.post("/api/auth/tickets/admin/status", {
					headers: { origin: process.env.BETTER_AUTH_URL! },
					data: {
						ticketId: ticket.id,
						status: "closed",
						expectedRevision: 1,
						idempotencyKey: randomUUID(),
					},
				})
			).status(),
		).toBe(403);

		await login(other, "/support", otherEmail);
		await expect(
			other.getByRole("heading", { name: "反馈中心", exact: true }),
		).toBeVisible();
		await expect(other.getByText(title, { exact: true })).toHaveCount(0);
		expect(
			(
				await other.request.get(`/api/auth/tickets/get?ticketId=${ticket.id}`)
			).status(),
		).toBe(404);
		expect(
			(
				await other.request.post("/api/auth/tickets/reply", {
					headers: { origin: process.env.BETTER_AUTH_URL! },
					data: {
						ticketId: ticket.id,
						content: "cannot append to another user",
						idempotencyKey: randomUUID(),
					},
				})
			).status(),
		).toBe(404);

		await login(manager, "/", "admin@dashboard-e2e.example");
		await manager.getByRole("tab", { name: "工单", exact: true }).click();
		await manager.getByRole("button").filter({ hasText: title }).click();
		await expect(manager.getByText(content, { exact: true })).toBeVisible();
		await manager
			.getByRole("group", { name: "工单处理状态" })
			.getByRole("button", { name: "处理中", exact: true })
			.click();
		await expect(
			manager.getByText("处理状态改为处理中", { exact: true }),
		).toBeVisible();
		await manager
			.getByLabel("追加回复")
			.fill("已收到反馈，我们正在核对付款记录。");
		const refreshed = [
			manager.waitForResponse((response) =>
				response.url().includes("/api/auth/tickets/admin/get?"),
			),
			manager.waitForResponse((response) =>
				response.url().includes("/api/auth/tickets/admin/list?"),
			),
		];
		await manager
			.getByRole("button", { name: "发送回复", exact: true })
			.click();
		await Promise.all(refreshed);
		await expect(
			manager.getByText("已收到反馈，我们正在核对付款记录。", { exact: true }),
		).toBeVisible();
		await expect(
			manager.getByRole("button", { name: "刷新工单", exact: true }),
		).toBeEnabled();
		await expect(
			manager.getByRole("button", { name: "刷新对话", exact: true }),
		).toBeEnabled();
		await manager.screenshot({
			path: resolve(
				process.env.DASHBOARD_E2E_DIRECTORY!,
				"tickets-admin-desktop.png",
			),
			fullPage: true,
		});
		await manager
			.getByRole("group", { name: "工单处理状态" })
			.getByRole("button", { name: "已关闭", exact: true })
			.click();
		await expect(
			manager.getByText("处理状态改为已关闭", { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "刷新对话", exact: true }).click();
		await expect(
			page.getByText("已收到反馈，我们正在核对付款记录。", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("工单已关闭，管理员重新打开后可继续回复。", {
				exact: true,
			}),
		).toBeVisible();
		expect(
			(
				await page.request.post("/api/auth/tickets/reply", {
					headers: { origin: process.env.BETTER_AUTH_URL! },
					data: {
						ticketId: ticket.id,
						content: "closed reply",
						idempotencyKey: randomUUID(),
					},
				})
			).status(),
		).toBe(409);

		await manager
			.getByRole("group", { name: "工单处理状态" })
			.getByRole("button", { name: "待处理", exact: true })
			.click();
		await expect(
			manager.getByText("处理状态改为待处理", { exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "刷新对话", exact: true }).click();
		await expect(page.getByLabel("追加回复")).toBeVisible();
		await page.getByLabel("追加回复").fill("重新打开后可以继续沟通。");
		await page.getByRole("button", { name: "发送回复", exact: true }).click();
		await expect(
			page.getByText("重新打开后可以继续沟通。", { exact: true }),
		).toBeVisible();
		await page.reload();
		await page.getByRole("button").filter({ hasText: title }).click();
		await expect(
			page.getByText("重新打开后可以继续沟通。", { exact: true }),
		).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			),
		).toBeLessThanOrEqual(1);
		await page.screenshot({
			path: resolve(
				process.env.DASHBOARD_E2E_DIRECTORY!,
				"tickets-customer-mobile.png",
			),
			fullPage: true,
		});
		await page.evaluate(() => localStorage.setItem("theme", "dark"));
		await page.reload();
		await page.getByRole("button").filter({ hasText: title }).click();
		await expect(
			page.getByText("重新打开后可以继续沟通。", { exact: true }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(
				process.env.DASHBOARD_E2E_DIRECTORY!,
				"tickets-customer-dark.png",
			),
			fullPage: true,
		});
	} finally {
		await closeAuth();
		await adminContext.close();
		await otherContext.close();
	}
});
