import type { MetricsEnvironment } from "@app/auth-sdk/metrics";
import { createMetricsHandler } from "@app/auth-sdk/metrics";
import { getTestInstance } from "better-auth/test";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	vi,
} from "vitest";

const token = "metrics-test-token-0123456789abcdef0123456789abcdef";
const env = {
	APP_METRICS_ENABLED: "true",
	APP_METRICS_TOKEN: token,
	APP_METRICS_SITE_ID: "site_a",
};
const now = new Date("2026-10-07T12:00:00.000Z");
const request = (init?: RequestInit, query = "") =>
	new Request(`https://example.com/internal/metrics${query}`, {
		headers: { authorization: `Bearer ${token}` },
		...init,
	});
const setup = async () => {
	const { auth } = await getTestInstance({}, { disableTestUser: true });
	const { adapter } = await auth.$context;
	const count = vi.spyOn(adapter, "count");
	const countPaidUsers = vi.fn(async () => 3);
	return { auth, count, countPaidUsers };
};
const expectPrivate = (response: Response) => {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("vary")?.toLowerCase()).toContain(
		"authorization",
	);
};
const expectLimited = (response: Response) => {
	expect(response.status).toBe(429);
	expect(response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
	expectPrivate(response);
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("private site metrics", () => {
	it("accepts Next.js environment types and Workers bindings", () => {
		interface NextEnvironment {
			readonly NODE_ENV: "production";
			[key: string]: string | undefined;
		}
		type WorkerEnvironment = {
			APP_METRICS_ENABLED: string;
			APP_METRICS_TOKEN: string;
			APP_METRICS_SITE_ID: string;
			DB: { prepare(query: string): unknown };
		};
		expectTypeOf<NextEnvironment>().toExtend<MetricsEnvironment>();
		expectTypeOf<WorkerEnvironment>().toExtend<MetricsEnvironment>();
	});

	it("requires an explicit environment opt-in and does no work when disabled", async () => {
		const { auth, count } = await setup();
		for (const enabled of [undefined, "false", "1", "TRUE"]) {
			const handler = createMetricsHandler({
				auth,
				env: { APP_METRICS_ENABLED: enabled },
			});
			const response = await handler(request());
			expect(response.status).toBe(404);
			expectPrivate(response);
		}
		expect(count).not.toHaveBeenCalled();
	});

	it("fails startup for incomplete or invalid enabled configuration", async () => {
		const { auth, count, countPaidUsers } = await setup();
		for (const override of [
			{ APP_METRICS_TOKEN: undefined },
			{ APP_METRICS_TOKEN: "short" },
			{ APP_METRICS_TOKEN: "a".repeat(257) },
			{ APP_METRICS_TOKEN: `${token} secret` },
			{ APP_METRICS_SITE_ID: undefined },
			{ APP_METRICS_SITE_ID: "" },
			{ APP_METRICS_SITE_ID: "a".repeat(129) },
			{ APP_METRICS_SITE_ID: "https://example.com" },
			{ APP_METRICS_RATE_LIMIT_PER_MINUTE: "0" },
			{ APP_METRICS_RATE_LIMIT_PER_MINUTE: "61" },
			{ APP_METRICS_RATE_LIMIT_PER_MINUTE: "1.5" },
			{ APP_METRICS_RATE_LIMIT_PER_MINUTE: "NaN" },
		]) {
			expect(() =>
				createMetricsHandler({
					auth,
					countPaidUsers,
					env: { ...env, ...override },
				}),
			).toThrow();
		}
		expect(() => createMetricsHandler({ auth, env })).toThrow();
		expect(count).not.toHaveBeenCalled();
		expect(countPaidUsers).not.toHaveBeenCalled();
	});

	it("counts mapped user records with inclusive start and exclusive end boundaries", async () => {
		const { auth } = await getTestInstance(
			{
				user: { modelName: "members", fields: { createdAt: "registered_at" } },
			},
			{ disableTestUser: true },
		);
		const { adapter } = await auth.$context;
		for (const [index, createdAt] of [
			"2026-09-30T11:59:59.999Z",
			"2026-09-30T12:00:00.000Z",
			"2026-10-06T12:00:00.000Z",
			"2026-10-07T12:00:00.000Z",
			"2026-10-08T12:00:00.000Z",
		].entries()) {
			await adapter.create({
				model: "user",
				data: {
					name: `Member ${index}`,
					email: `member-${index}@example.com`,
					emailVerified: false,
					createdAt: new Date(createdAt),
					updatedAt: now,
				},
			});
		}
		const countPaidUsers = vi.fn(async () => 2);
		const response = await createMetricsHandler({ auth, env, countPaidUsers })(
			request(),
		);
		expect(response.status).toBe(200);
		expectPrivate(response);
		expect(await response.json()).toEqual({
			siteId: "site_a",
			generatedAt: now.toISOString(),
			timezone: "UTC",
			totalUsers: 5,
			newUsers7d: 2,
			paidUsersThisMonth: 2,
			periods: {
				newUsers: {
					from: "2026-09-30T12:00:00.000Z",
					to: now.toISOString(),
				},
				paidUsers: {
					from: "2026-10-01T00:00:00.000Z",
					to: now.toISOString(),
				},
			},
		});
		expect(countPaidUsers).toHaveBeenCalledWith({
			from: new Date("2026-10-01T00:00:00.000Z"),
			to: now,
			signal: expect.any(AbortSignal),
		});
	});

	it("accepts only bearer credentials and rejects alternate request shapes before queries", async () => {
		const { auth, count, countPaidUsers } = await setup();
		const handler = createMetricsHandler({ auth, env, countPaidUsers });
		const invalidHeaders: HeadersInit[] = [
			{},
			{ cookie: `better-auth.session_token=${token}` },
			{ authorization: `Basic ${token}` },
			{ authorization: `Bearer ${token.slice(0, -1)}x` },
			{ authorization: `Bearer ${token}, Bearer ${token}` },
		];
		for (const headers of invalidHeaders) {
			const response = await handler(request({ headers }));
			expect(response.status).toBe(401);
			expectPrivate(response);
		}
		const post = await handler(request({ method: "POST" }));
		expect(post.status).toBe(405);
		expectPrivate(post);
		const query = await handler(request(undefined, "?from=2020-01-01"));
		expect(query.status).toBe(400);
		expectPrivate(query);
		expect(count).not.toHaveBeenCalled();
		expect(countPaidUsers).not.toHaveBeenCalled();
		const valid = await handler(
			request({ headers: { authorization: `bEaReR ${token}` } }),
		);
		expect(valid.status).toBe(200);
	});

	it("limits authenticated cached requests without trusting caller-provided IPs", async () => {
		const { auth, count, countPaidUsers } = await setup();
		const handler = createMetricsHandler({ auth, env, countPaidUsers });
		for (let index = 0; index < 6; index++) {
			expect(
				(
					await handler(
						request({
							headers: {
								authorization: `Bearer ${token}`,
								"x-forwarded-for": `192.0.2.${index}`,
							},
						}),
					)
				).status,
			).toBe(200);
		}
		expectLimited(await handler(request()));
		expect(count).toHaveBeenCalledTimes(2);
		expect(countPaidUsers).toHaveBeenCalledTimes(1);
		vi.setSystemTime(now.getTime() + 60_000);
		expect((await handler(request())).status).toBe(200);
		expect(count).toHaveBeenCalledTimes(4);
	});

	it("caps unauthenticated attempts before they can reach the database", async () => {
		const { auth, count, countPaidUsers } = await setup();
		const handler = createMetricsHandler({ auth, env, countPaidUsers });
		for (let index = 0; index < 60; index++) {
			expect((await handler(request({ headers: {} }))).status).toBe(401);
		}
		expectLimited(await handler(request()));
		expect(count).not.toHaveBeenCalled();
		expect(countPaidUsers).not.toHaveBeenCalled();
		vi.setSystemTime(now.getTime() + 60_000);
		expect((await handler(request())).status).toBe(200);
	});

	it("enforces a shared quota across instances, including cache hits", async () => {
		const { auth, countPaidUsers } = await setup();
		let consumed = 0;
		const consume = vi.fn(
			async (_key: string, rule: { window: number; max: number }) => {
				const allowed = ++consumed <= rule.max;
				return { allowed, retryAfter: allowed ? null : 60 };
			},
		);
		const options = {
			auth,
			countPaidUsers,
			env: { ...env, APP_METRICS_RATE_LIMIT_PER_MINUTE: "3" },
			rateLimitStorage: { consume },
		};
		const first = createMetricsHandler(options);
		const second = createMetricsHandler(options);
		expect((await first(request())).status).toBe(200);
		expect((await second(request())).status).toBe(200);
		expect((await first(request())).status).toBe(200);
		expectLimited(await second(request()));
		expect(countPaidUsers).toHaveBeenCalledTimes(2);
		expect(consume).toHaveBeenCalledTimes(4);
		expect(consume).toHaveBeenCalledWith("app-metrics:site_a", {
			window: 60,
			max: 3,
		});
	});

	it("fails closed when shared quota storage is unavailable", async () => {
		const { auth, count, countPaidUsers } = await setup();
		const consume = vi.fn(async () => {
			throw new Error("redis-private-password");
		});
		const handler = createMetricsHandler({
			auth,
			env,
			countPaidUsers,
			rateLimitStorage: { consume },
		});
		expect((await handler(request({ headers: {} }))).status).toBe(401);
		expect(consume).not.toHaveBeenCalled();
		const response = await handler(request());
		expect(response.status).toBe(503);
		expectPrivate(response);
		expect(await response.text()).not.toContain("redis-private-password");
		expect(count).not.toHaveBeenCalled();
		expect(countPaidUsers).not.toHaveBeenCalled();
	});

	it("expires cached snapshots after 60 seconds and at UTC month boundaries", async () => {
		const { auth, countPaidUsers } = await setup();
		vi.setSystemTime(new Date("2026-10-31T23:59:40.000Z"));
		const handler = createMetricsHandler({ auth, env, countPaidUsers });
		const first = await (await handler(request())).json();
		vi.setSystemTime(new Date("2026-10-31T23:59:59.000Z"));
		expect(await (await handler(request())).json()).toEqual(first);
		expect(countPaidUsers).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
		const nextMonth = await (await handler(request())).json();
		expect(nextMonth.periods.paidUsers.from).toBe("2026-11-01T00:00:00.000Z");
		expect(countPaidUsers).toHaveBeenCalledTimes(2);
		vi.setSystemTime(new Date("2026-11-01T00:00:59.999Z"));
		expect(await (await handler(request())).json()).toEqual(nextMonth);
		vi.setSystemTime(new Date("2026-11-01T00:01:00.000Z"));
		expect((await handler(request())).status).toBe(200);
		expect(countPaidUsers).toHaveBeenCalledTimes(3);
	});

	it("hides collection failures and waits a minute before retrying", async () => {
		const { auth, count, countPaidUsers } = await setup();
		countPaidUsers.mockRejectedValueOnce(new Error("private-payment-data"));
		const handler = createMetricsHandler({ auth, env, countPaidUsers });
		const response = await handler(request());
		expect(response.status).toBe(503);
		expectPrivate(response);
		expect(await response.text()).not.toContain("private-payment-data");
		expect((await handler(request())).status).toBe(503);
		expect(count).toHaveBeenCalledTimes(2);
		expect(countPaidUsers).toHaveBeenCalledTimes(1);
		vi.setSystemTime(now.getTime() + 60_000);
		expect((await handler(request())).status).toBe(200);
		expect(countPaidUsers).toHaveBeenCalledTimes(2);
	});

	it.each([
		-1,
		0.5,
		Number.MAX_SAFE_INTEGER + 1,
		Number.NaN,
	])("rejects invalid aggregate values (%s) from payment and user sources", async (invalid) => {
		const { auth, count, countPaidUsers } = await setup();
		countPaidUsers.mockResolvedValue(invalid);
		expect(
			(await createMetricsHandler({ auth, env, countPaidUsers })(request()))
				.status,
		).toBe(503);
		countPaidUsers.mockResolvedValue(0);
		count.mockResolvedValue(invalid);
		expect(
			(await createMetricsHandler({ auth, env, countPaidUsers })(request()))
				.status,
		).toBe(503);
	});

	it.each([
		false,
		true,
	])("retains the collection lock after timeout until all queries settle (early failure: %s)", async (earlyFailure) => {
		const { auth, count, countPaidUsers } = await setup();
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		let finishQueries!: (value: number) => void;
		const pendingQueries = new Promise<number>((resolve) => {
			finishQueries = resolve;
		});
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		count
			.mockImplementationOnce(() =>
				earlyFailure
					? Promise.reject(new Error("first count failed"))
					: pendingQueries,
			)
			.mockImplementationOnce(() => {
				markStarted();
				return pendingQueries;
			});
		const handler = createMetricsHandler({ auth, env, countPaidUsers });
		const first = handler(request());
		await started;
		expect((await handler(request())).status).toBe(503);
		expect(count).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(5_001);
		const timedOut = await first;
		expect(timedOut.status).toBe(503);
		expectPrivate(timedOut);
		expect(countPaidUsers).toHaveBeenCalledWith(
			expect.objectContaining({
				signal: expect.objectContaining({ aborted: true }),
			}),
		);
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await handler(request())).status).toBe(503);
		expect(count).toHaveBeenCalledTimes(2);
		finishQueries(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect((await handler(request())).status).toBe(200);
		expect(count).toHaveBeenCalledTimes(4);
	});
});
