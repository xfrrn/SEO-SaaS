import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("Google login uses the real auth route and returns cancellation to the login form", async ({
	page,
}) => {
	await page.route("https://accounts.google.com/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<h1>Test Google authorization</h1>",
		}),
	);
	await page.goto("/");
	const button = page.getByRole("button", {
		name: "使用 Google 账号登录",
		exact: true,
	});
	await expect(button).toBeVisible();
	expect(await page.content()).not.toContain(process.env.GOOGLE_CLIENT_SECRET!);
	for (const [name, width, height, theme] of [
		["google-login-desktop", 1440, 1000, "light"],
		["google-login-mobile", 390, 844, "light"],
		["google-login-dark", 390, 844, "dark"],
	] as const) {
		await page.setViewportSize({ width, height });
		await page.emulateMedia({ colorScheme: theme });
		await page.evaluate((value) => localStorage.setItem("theme", value), theme);
		await page.reload();
		await expect(button).toBeVisible();
		await expect(page.locator("html")).toHaveClass(theme);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - window.innerWidth,
			),
		).toBeLessThanOrEqual(1);
		await page.screenshot({
			path: resolve(process.env.DASHBOARD_E2E_DIRECTORY!, `${name}.png`),
			fullPage: true,
		});
	}
	await button.focus();
	await expect(button).toBeFocused();
	const request = page.waitForRequest((request) =>
		request.url().endsWith("/api/auth/sign-in/social"),
	);
	await button.press("Enter");
	expect((await request).postDataJSON()).toMatchObject({
		provider: "google",
		callbackURL: "/",
		errorCallbackURL: "/",
	});
	await page.waitForURL("https://accounts.google.com/**");
	const authorization = new URL(page.url());
	expect(authorization.searchParams.get("client_id")).toBe(
		process.env.GOOGLE_CLIENT_ID,
	);
	expect(authorization.searchParams.get("redirect_uri")).toBe(
		`${process.env.BETTER_AUTH_URL}/api/auth/callback/google`,
	);
	expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
	const query = new URLSearchParams({
		error: "access_denied",
		state: authorization.searchParams.get("state")!,
	});
	await page.goto(`/api/auth/callback/google?${query}`);
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"已取消 Google 授权，可以重试或使用邮箱密码登录。",
	);
	await expect(button).toBeEnabled();
	await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
});

test("Google errors remain actionable and never render provider or query error text", async ({
	page,
}) => {
	await page.goto(
		"/?error=__proto__&error_description=untrusted-provider-description",
	);
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"Google 认证未完成，请重试；持续失败时请联系管理员检查登录配置。",
	);
	await expect(page.locator("body")).not.toContainText(
		"untrusted-provider-description",
	);
	await page.route("**/api/auth/sign-in/social", (route) =>
		route.fulfill({ status: 503, json: { message: "测试认证服务暂时不可用" } }),
	);
	await page
		.getByRole("button", { name: "使用 Google 账号登录", exact: true })
		.click();
	await expect(page.getByRole("main").getByRole("alert")).toHaveText(
		"测试认证服务暂时不可用",
	);
	await expect(
		page.getByRole("button", { name: "使用 Google 账号登录", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "登录", exact: true }),
	).toBeEnabled();
	await page.goto("/?error=account_not_linked");
	await expect(page.getByRole("main").getByRole("alert")).toContainText(
		"请先使用邮箱密码登录",
	);
});

test("an existing administrator can start Google binding and keep the session after cancelling", async ({
	page,
}) => {
	const response = await page.request.post("/api/auth/sign-in/email", {
		headers: { origin: process.env.BETTER_AUTH_URL! },
		data: {
			email: "admin@dashboard-e2e.example",
			password: process.env.DASHBOARD_E2E_PASSWORD!,
		},
	});
	expect(response.ok()).toBe(true);
	await page.route("https://accounts.google.com/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<h1>Test Google authorization</h1>",
		}),
	);
	await page.goto("/");
	const binding = page.getByRole("button", {
		name: "绑定 Google 账号",
		exact: true,
	});
	await expect(binding).toBeVisible();
	await binding.click();
	await page.waitForURL("https://accounts.google.com/**");
	const state = new URL(page.url()).searchParams.get("state")!;
	await page.goto(
		`/api/auth/callback/google?${new URLSearchParams({ state, error: "access_denied" })}`,
	);
	await expect(
		page.getByRole("heading", { name: "管理后台", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("main").getByRole("alert")).toContainText(
		"已取消 Google 授权",
	);
	await expect(binding).toBeEnabled();
});
