import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Run against a local demo; all authentication requests are intercepted below.
// From e2e/integration (PowerShell): $env:ADMIN_TEST_BASE_URL="http://localhost:3100"; pnpm exec playwright test nextjs-demo/e2e/admin-dashboard.spec.ts --project=chromium
test.skip(
	!process.env.ADMIN_TEST_BASE_URL,
	"Set ADMIN_TEST_BASE_URL to a running Next.js demo",
);
test.use({
	baseURL: process.env.ADMIN_TEST_BASE_URL,
	timezoneId: "UTC",
});

const user = {
	id: "test-user",
	name: "Maya Chen",
	email: "maya@example.com",
	role: "user",
	emailVerified: true,
	banned: false,
	image: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

async function mockAuthentication(page: Page, role = "admin") {
	await page.route("**/api/auth/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/api/auth/get-session") {
			await route.fulfill({
				json: {
					user: { ...user, id: "test-admin", name: "Alex Morgan", role },
					session: {
						id: "test-session",
						token: "mock-session",
						userId: "test-admin",
						expiresAt: "2099-01-01T00:00:00.000Z",
						createdAt: user.createdAt,
						updatedAt: user.updatedAt,
					},
				},
			});
			return;
		}
		if (path === "/api/auth/admin/list-users") {
			await route.fulfill({ json: { users: [user], total: 1 } });
			return;
		}
		await route.fulfill({
			status: 400,
			json: { code: "UNEXPECTED_TEST_REQUEST", message: "Unexpected request" },
		});
	});
}

test("renders user management for an administrator", async ({ page }) => {
	await mockAuthentication(page);
	await page.goto("/admin");
	await expect(
		page.getByRole("heading", { name: /^User management\.?$/ }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: `Actions for ${user.email}` }),
	).toBeVisible();
});

/**
 * @see https://www.better-auth.com/docs/plugins/admin#list-users
 */
test("paginates, filters, searches, and distinguishes empty results from errors", async ({
	page,
}) => {
	await mockAuthentication(page);
	const queries: Record<string, string>[] = [];
	const users = Array.from({ length: 12 }, (_, index) => ({
		...user,
		id: `user-${index}`,
		name: index === 0 ? user.name : `Member ${index}`,
		email: index === 0 ? user.email : `member-${index}@example.com`,
		role: index === 1 ? "admin" : "user",
		banned: index === 2,
	}));
	await page.route("**/api/auth/admin/list-users?*", async (route) => {
		const params = new URL(route.request().url()).searchParams;
		const limit = Number(params.get("limit"));
		const offset = Number(params.get("offset"));
		if (limit === 10) queries.push(Object.fromEntries(params));
		if (params.get("searchValue") === "unavailable") {
			await route.fulfill({
				status: 503,
				json: { code: "UNAVAILABLE", message: "Directory unavailable" },
			});
			return;
		}
		const filtered = users.filter((entry) => {
			if (params.get("filterField") === "role" && entry.role !== "admin") {
				return false;
			}
			if (params.get("filterField") === "banned" && !entry.banned) {
				return false;
			}
			const searchValue = params.get("searchValue");
			return (
				!searchValue ||
				entry[params.get("searchField") === "name" ? "name" : "email"]
					.toLowerCase()
					.includes(searchValue.toLowerCase())
			);
		});
		await route.fulfill({
			json: {
				users: filtered.slice(offset, offset + limit),
				total: filtered.length,
				limit,
				offset,
			},
		});
	});
	await page.goto("/admin");
	await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
	await page.getByRole("button", { name: "Next page" }).click();
	await expect.poll(() => queries.at(-1)).toMatchObject({ offset: "10" });
	await expect(page.getByText("member-11@example.com", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();

	await page.getByRole("button", { name: "Administrators", exact: true }).click();
	await expect.poll(() => queries.at(-1)).toMatchObject({
		offset: "0",
		filterField: "role",
		filterValue: "admin",
	});
	await expect(page.getByText("member-1@example.com", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Suspended", exact: true }).click();
	await expect.poll(() => queries.at(-1)).toMatchObject({
		filterField: "banned",
		filterValue: "true",
	});
	await expect(page.getByText("member-2@example.com", { exact: true })).toBeVisible();

	await page
		.getByRole("group", { name: "Filter users" })
		.getByRole("button", { name: /^All users/ })
		.click();
	await page.getByRole("textbox", { name: "Search users" }).fill("maya");
	await expect.poll(() => queries.at(-1)).toMatchObject({
		searchField: "email",
		searchValue: "maya",
		offset: "0",
	});
	await expect(page.getByText(user.email, { exact: true })).toBeVisible();
	await page.getByLabel("Search field").selectOption("name");
	await page.getByRole("textbox", { name: "Search users" }).fill("Member 11");
	await expect.poll(() => queries.at(-1)).toMatchObject({
		searchField: "name",
		searchValue: "Member 11",
	});
	await expect(page.getByText("member-11@example.com", { exact: true })).toBeVisible();

	await page.getByRole("textbox", { name: "Search users" }).fill("missing");
	await expect(page.getByText("No users found", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
	await page.getByRole("textbox", { name: "Search users" }).fill("unavailable");
	await expect(page.getByText("Unable to load users", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(page.getByText("No users found", { exact: true })).toHaveCount(0);
});

test("keeps the create form open when the API rejects a new user", async ({
	page,
}) => {
	await mockAuthentication(page);
	await page.route("**/api/auth/admin/create-user", (route) =>
		route.fulfill({
			status: 400,
			json: { code: "USER_ALREADY_EXISTS", message: "Email already exists" },
		}),
	);
	await page.goto("/admin");
	await page.getByRole("button", { name: "Create user", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Create user", exact: true });
	await dialog.getByLabel("Name", { exact: true }).fill("New Member");
	await dialog.getByLabel("Email", { exact: true }).fill("existing@example.com");
	await dialog.getByLabel("Password", { exact: true }).fill("test-password-123");
	const request = page.waitForRequest("**/api/auth/admin/create-user");
	await dialog.getByRole("button", { name: "Create user", exact: true }).click();
	expect((await request).postDataJSON()).toMatchObject({
		name: "New Member",
		email: "existing@example.com",
		password: "test-password-123",
		role: "user",
	});
	await expect(page.getByText("Email already exists", { exact: true })).toBeVisible();
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue(
		"existing@example.com",
	);
	await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Create user", exact: true }),
	).toBeFocused();
});

/**
 * @see https://www.better-auth.com/docs/plugins/admin#ban-user
 */
test("sends suspension expiry in seconds and requires delete confirmation", async ({
	page,
}) => {
	await mockAuthentication(page);
	await page.clock.setFixedTime(new Date("2026-10-04T12:00:00.000Z"));
	await page.route("**/api/auth/admin/ban-user", (route) =>
		route.fulfill({ json: { user: { ...user, banned: true } } }),
	);
	let deleteRequests = 0;
	await page.route("**/api/auth/admin/remove-user", (route) => {
		deleteRequests += 1;
		return route.fulfill({ json: { success: true } });
	});
	await page.goto("/admin");
	await page.getByRole("button", { name: `Actions for ${user.email}` }).click();
	await page.getByRole("menuitem", { name: "Suspend user", exact: true }).click();
	const suspension = page.getByRole("dialog", { name: "Suspend user", exact: true });
	await suspension.getByLabel("Reason", { exact: true }).fill("Account review");
	await suspension.getByLabel("Suspend until").fill("2026-10-05T12:00");
	const banRequest = page.waitForRequest("**/api/auth/admin/ban-user");
	await suspension.getByRole("button", { name: "Suspend user", exact: true }).click();
	expect((await banRequest).postDataJSON()).toMatchObject({
		userId: user.id,
		banReason: "Account review",
		banExpiresIn: 86_400,
	});
	await expect(suspension).toHaveCount(0);

	await page.getByRole("button", { name: `Actions for ${user.email}` }).click();
	await page.getByRole("menuitem", { name: "Delete user", exact: true }).click();
	const deletion = page.getByRole("dialog", { name: "Delete user", exact: true });
	await expect(deletion).toBeVisible();
	expect(deleteRequests).toBe(0);
	await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(deletion).toHaveCount(0);
	expect(deleteRequests).toBe(0);
	await expect(
		page.getByRole("button", { name: `Actions for ${user.email}` }),
	).toBeFocused();

	await page.getByRole("button", { name: `Actions for ${user.email}` }).click();
	await page.getByRole("menuitem", { name: "Delete user", exact: true }).click();
	const deleteRequest = page.waitForRequest("**/api/auth/admin/remove-user");
	await deletion.getByRole("button", { name: "Delete user", exact: true }).click();
	expect((await deleteRequest).postDataJSON()).toEqual({ userId: user.id });
	await expect(deletion).toHaveCount(0);
	expect(deleteRequests).toBe(1);
});

test("restores access and revokes the selected user's sessions", async ({ page }) => {
	await mockAuthentication(page);
	let banned = true;
	await page.route("**/api/auth/admin/list-users?*", (route) =>
		route.fulfill({ json: { users: [{ ...user, banned }], total: 1 } }),
	);
	await page.route("**/api/auth/admin/unban-user", (route) => {
		banned = false;
		return route.fulfill({ json: { user: { ...user, banned } } });
	});
	await page.route("**/api/auth/admin/revoke-user-sessions", (route) =>
		route.fulfill({ json: { success: true } }),
	);
	await page.goto("/admin");
	await page.getByRole("button", { name: `Actions for ${user.email}` }).click();
	const restoreRequest = page.waitForRequest("**/api/auth/admin/unban-user");
	await page.getByRole("menuitem", { name: "Restore access", exact: true }).click();
	expect((await restoreRequest).postDataJSON()).toEqual({ userId: user.id });
	await expect(page.getByRole("table").getByText("Active", { exact: true })).toBeVisible();
	await expect(page.getByText("User access restored", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: `Actions for ${user.email}` }).click();
	const revokeRequest = page.waitForRequest("**/api/auth/admin/revoke-user-sessions");
	await page.getByRole("menuitem", { name: "Revoke sessions", exact: true }).click();
	expect((await revokeRequest).postDataJSON()).toEqual({ userId: user.id });
	await expect(page.getByText("Sessions revoked successfully", { exact: true })).toBeVisible();
});

test("redirects non-admin users without requesting the admin directory", async ({
	page,
}) => {
	await mockAuthentication(page, "user");
	const adminRequests: string[] = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/auth/admin/")) {
			adminRequests.push(request.url());
		}
	});
	const redirect = page.waitForRequest(
		(request) => new URL(request.url()).pathname === "/dashboard",
	);
	await page.goto("/admin");
	await redirect;
	await expect(
		page.getByRole("heading", { name: /^User management\.?$/ }),
	).toHaveCount(0);
	expect(adminRequests).toEqual([]);
});

test("keeps mobile controls and dialogs within the viewport", async ({
	page,
}, testInfo) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await mockAuthentication(page);
	await page.goto("/admin");
	await expect(page.getByRole("heading", { name: "User management" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Search users" })).toBeVisible();
	await page.getByRole("button", { name: "Toggle navigation" }).click();
	await expect(page.getByRole("navigation", { name: "Mobile admin navigation" })).toBeVisible();
	await page.getByRole("button", { name: "Toggle navigation" }).click();
	await expect(page.getByRole("navigation", { name: "Mobile admin navigation" })).toHaveCount(0);
	await page.screenshot({
		path: testInfo.outputPath("admin-mobile.png"),
		fullPage: true,
	});
	const layout = await page.evaluate(() => ({
		viewport: innerWidth,
		page: document.documentElement.scrollWidth,
	}));
	expect(layout.page, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
	await page.getByRole("button", { name: "Create user", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Create user", exact: true });
	await expect(dialog).toBeVisible();
	const bounds = await dialog.boundingBox();
	expect(bounds).not.toBeNull();
	expect(bounds?.x).toBeGreaterThanOrEqual(0);
	expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
});
