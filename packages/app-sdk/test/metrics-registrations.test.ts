import {
	collectRegistrationMetrics,
	createMetricsHandler,
	parseMetricsQuery,
} from "@app/auth-sdk/metrics";
import { getTestInstance } from "better-auth/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const token = "aggregate-test-token-0123456789abcdef0123456789abcdef";
const usersToken = "users-test-token-0123456789abcdef0123456789abcdef";
const env = {
	APP_METRICS_ENABLED: "true",
	APP_METRICS_TOKEN: token,
	APP_METRICS_USERS_TOKEN: usersToken,
	APP_METRICS_SITE_ID: "site_a",
};
const now = new Date("2026-10-07T12:00:00.000Z");
const period = "from=2026-10-01&to=2026-10-08";
const request = (
	query = `view=registrations&${period}`,
	credential = token,
	method = "GET",
) =>
	new Request(`https://example.com/internal/metrics?${query}`, {
		method,
		headers: { authorization: `Bearer ${credential}` },
	});
const setup = async () => {
	const { auth } = await getTestInstance(
		{
			user: {
				modelName: "player_user",
				fields: { createdAt: "registered_at", emailVerified: "verified_email" },
			},
		},
		{ disableTestUser: true },
	);
	const { adapter } = await auth.$context;
	const addUser = (
		id: string,
		createdAt = "2026-10-02T00:00:00.000Z",
		emailVerified = false,
		name = `Player ${id}`,
	) => {
		const data = {
			id,
			name,
			email: `${id}@example.com`,
			emailVerified,
			createdAt: new Date(createdAt),
			updatedAt: now,
		};
		return adapter.create<typeof data>({
			model: "user",
			forceAllowId: true,
			data,
		});
	};
	return {
		auth,
		adapter,
		addUser,
		handler: createMetricsHandler({ auth, env }),
	};
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("registration and private user metrics", () => {
	it("exports the trusted server service and honors an already cancelled signal before querying", async () => {
		const { adapter } = await setup();
		const query = parseMetricsQuery(new URL(request().url), now.getTime());
		if (query.view === "snapshot")
			throw new Error("Expected registration query");
		const count = vi.spyOn(adapter, "count");
		const controller = new AbortController();
		controller.abort();
		await expect(
			collectRegistrationMetrics(adapter, query, "site_a", controller.signal),
		).rejects.toThrow();
		expect(count).not.toHaveBeenCalled();
	});
	it("counts mapped current users once, using UTC boundaries and complete zero days", async () => {
		const { handler, adapter, addUser } = await setup();
		await addUser("before", "2026-09-30T23:59:59.999Z", true);
		await addUser("start", "2026-10-01T00:00:00.000Z", true);
		await addUser("within", "2026-10-02T23:59:59.999Z");
		await addUser("end", "2026-10-08T00:00:00.000Z", true);
		await addUser("future", "2026-10-07T12:00:00.001Z", true);
		await addUser("asof", now.toISOString(), true);
		const deleted = await addUser("deleted", "2026-10-03T00:00:00.000Z");
		await adapter.delete({
			model: "user",
			where: [{ field: "id", value: deleted.id }],
		});
		for (const providerId of ["google", "github"])
			await adapter.create({
				model: "account",
				data: {
					userId: "start",
					providerId,
					accountId: `${providerId}-start`,
					createdAt: now,
					updatedAt: now,
				},
			});
		const find = vi.spyOn(adapter, "findMany");
		const response = await handler(request());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			schemaVersion: 2,
			siteId: "site_a",
			timezone: "UTC",
			generatedAt: now.toISOString(),
			period: { from: "2026-10-01", to: "2026-10-08" },
			basis: "current_accounts",
			totalUsers: 6,
			registeredUsers: 2,
			verifiedUsers: 1,
			unverifiedUsers: 1,
			daily: [
				{ date: "2026-10-01", registrations: 1, verifiedUsers: 1 },
				{ date: "2026-10-02", registrations: 1, verifiedUsers: 0 },
				...Array.from({ length: 5 }, (_, index) => ({
					date: `2026-10-0${index + 3}`,
					registrations: 0,
					verifiedUsers: 0,
				})),
			],
		});
		expect(find).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "user",
				select: ["id", "emailVerified", "createdAt"],
				limit: 500,
			}),
		);
	});

	it("returns real zero counts and keeps missing payment integration as null", async () => {
		const { handler } = await setup();
		const empty = await (await handler(request())).json();
		expect(empty).toMatchObject({
			totalUsers: 0,
			registeredUsers: 0,
			verifiedUsers: 0,
			unverifiedUsers: 0,
		});
		expect(empty.daily).toHaveLength(7);
		expect(
			empty.daily.every(
				(day: { registrations: number; verifiedUsers: number }) =>
					day.registrations === 0 && day.verifiedUsers === 0,
			),
		).toBe(true);
		expect(await (await handler(request(""))).json()).toMatchObject({
			paidUsersThisMonth: null,
		});
	});

	it("isolates email access from aggregate access and never grants writes", async () => {
		const { handler, adapter, auth } = await setup();
		const find = vi.spyOn(adapter, "findMany");
		for (const [query, credential] of [
			[`view=users&${period}`, token],
			[`view=registrations&${period}`, usersToken],
			["", usersToken],
		]) {
			expect((await handler(request(query, credential))).status).toBe(403);
		}
		expect(
			(await handler(request(`view=users&${period}`, usersToken, "POST")))
				.status,
		).toBe(405);
		expect(find).not.toHaveBeenCalled();
		const noUsers = createMetricsHandler({
			auth,
			env: { ...env, APP_METRICS_USERS_TOKEN: undefined },
		});
		expect((await noUsers(request(`view=users&${period}`))).status).toBe(403);
		for (const users of [token, "short", ""])
			expect(() =>
				createMetricsHandler({
					auth,
					env: { ...env, APP_METRICS_USERS_TOKEN: users },
				}),
			).toThrow();
	});

	it("searches literal email or nickname, provides stable pages, and projects only approved fields", async () => {
		const { handler, adapter, addUser } = await setup();
		for (let index = 0; index < 25; index++)
			await addUser(
				`user${String(index).padStart(2, "0")}`,
				"2026-10-02T00:00:00.000Z",
				index === 0,
			);
		await addUser(
			"newest",
			"2026-10-07T00:00:00.000Z",
			true,
			"Nickname Needle",
		);
		await addUser(
			"outside",
			"2026-09-01T00:00:00.000Z",
			true,
			"Nickname Needle",
		);
		const first = await handler(request(`view=users&${period}`, usersToken));
		expect(first.headers.get("cache-control")).toBe("no-store");
		const page1 = await first.json();
		expect(page1).toMatchObject({
			schemaVersion: 2,
			siteId: "site_a",
			generatedAt: now.toISOString(),
			period: { from: "2026-10-01", to: "2026-10-08" },
			total: 26,
			page: 1,
			pageSize: 20,
		});
		expect(page1.items.map((row: { id: string }) => row.id)).toEqual([
			"newest",
			...Array.from(
				{ length: 19 },
				(_, index) => `user${String(index).padStart(2, "0")}`,
			),
		]);
		expect(Object.keys(page1.items[0]).sort()).toEqual([
			"createdAt",
			"email",
			"emailVerified",
			"id",
			"name",
		]);
		const page2 = await (
			await handler(request(`view=users&${period}&page=2`, usersToken))
		).json();
		expect(page2.items.map((row: { id: string }) => row.id)).toEqual([
			"user19",
			"user20",
			"user21",
			"user22",
			"user23",
			"user24",
		]);
		const nickname = await (
			await handler(request(`view=users&${period}&q=NEEDLE`, usersToken))
		).json();
		expect(nickname.total).toBe(1);
		expect(nickname.items[0].id).toBe("newest");
		const email = await (
			await handler(
				request(`view=users&${period}&q=USER24%40EXAMPLE`, usersToken),
			)
		).json();
		expect(email.total).toBe(1);
		const literal = await (
			await handler(request(`view=users&${period}&q=%25`, usersToken))
		).json();
		expect(literal.total).toBe(0);
		await adapter.delete({
			model: "user",
			where: [{ field: "id", value: "newest" }],
		});
		const fresh = await (
			await handler(request(`view=users&${period}&q=needle`, usersToken))
		).json();
		expect(fresh.total).toBe(0);
	});

	it("reads every bounded adapter page rather than silently accepting a short batch", async () => {
		const { handler, adapter, addUser } = await setup();
		await addUser("a");
		await addUser("b");
		await addUser("c");
		const original = adapter.findMany.bind(adapter);
		const find = vi
			.spyOn(adapter, "findMany")
			.mockImplementation((args) => original({ ...args, limit: 1 }));
		const body = await (await handler(request())).json();
		expect(body.registeredUsers).toBe(3);
		expect(find).toHaveBeenCalledTimes(4);
		expect(find.mock.calls[1]![0].where).toContainEqual({
			field: "id",
			operator: "gt",
			value: "a",
		});
	});

	it("rejects a detected account change during collection instead of returning partial success", async () => {
		const { handler, adapter, addUser } = await setup();
		await addUser("a");
		const original = adapter.findMany.bind(adapter);
		vi.spyOn(adapter, "findMany").mockImplementationOnce(async (args) => {
			await addUser("b");
			return original(args);
		});
		const response = await handler(request());
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "Metrics unavailable" });
	});

	it.each([
		"view=registrations",
		"view=unknown&from=2026-10-01&to=2026-10-02",
		"view=registrations&from=2026-02-30&to=2026-03-01",
		"view=registrations&from=2026-10-08&to=2026-10-09",
		"view=registrations&from=2026-10-01&to=2026-10-09",
		"view=registrations&from=2026-10-02&to=2026-10-01",
		"view=registrations&from=2025-01-01&to=2026-10-01",
		"view=registrations&from=2026-10-01&to=2026-10-01",
		`view=registrations&${period}&from=2026-10-02`,
		`view=registrations&${period}&q=x`,
		`view=users&${period}&page=0`,
		`view=users&${period}&page=1.5`,
		`view=users&${period}&page=1&page=2`,
		`view=users&${period}&q=${"x".repeat(201)}`,
		`view=users&${period}&token=x`,
		`view=users&${period}&view=users`,
	])("rejects malformed, repeated, future or unknown query parameters: %s", async (query) => {
		const { handler, adapter } = await setup();
		const count = vi.spyOn(adapter, "count");
		const find = vi.spyOn(adapter, "findMany");
		expect((await handler(request(query))).status).toBe(400);
		expect(count).not.toHaveBeenCalled();
		expect(find).not.toHaveBeenCalled();
	});

	it("accepts the maximum 366 UTC days and a tomorrow exclusive endpoint", async () => {
		const { handler } = await setup();
		const response = await handler(
			request("view=registrations&from=2025-10-07&to=2026-10-08"),
		);
		expect(response.status).toBe(200);
		expect((await response.json()).daily).toHaveLength(366);
	});

	it("fails closed on excessive scans, duplicate adapter rows and underlying errors", async () => {
		const { auth, adapter, addUser } = await setup();
		await addUser("a");
		const find = vi.spyOn(adapter, "findMany");
		find.mockRejectedValueOnce(new Error("private database failure"));
		const failed = await createMetricsHandler({ auth, env })(request());
		expect(failed.status).toBe(503);
		expect(await failed.text()).not.toContain("private database failure");
		find.mockImplementation(async () => [
			{ id: "a", emailVerified: false, createdAt: new Date("2026-10-02") },
		]);
		expect((await createMetricsHandler({ auth, env })(request())).status).toBe(
			503,
		);
		let id = 0;
		find.mockImplementation(async (args) =>
			Array.from({ length: args.limit! }, () => ({
				id: String(++id).padStart(6, "0"),
				emailVerified: false,
				createdAt: new Date("2026-10-02"),
			})),
		);
		expect((await createMetricsHandler({ auth, env })(request())).status).toBe(
			503,
		);
	});

	it("retains the lock after a new-view timeout until its database query settles", async () => {
		const { handler, adapter } = await setup();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		let release!: (value: never[]) => void;
		const pending = new Promise<never[]>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const find = vi.spyOn(adapter, "findMany").mockImplementationOnce(() => {
			started();
			return pending;
		});
		const first = handler(request());
		await ready;
		await vi.advanceTimersByTimeAsync(5001);
		expect((await first).status).toBe(503);
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await handler(request())).status).toBe(503);
		expect(find).toHaveBeenCalledTimes(1);
		release([]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await handler(request())).status).toBe(200);
	});
});
