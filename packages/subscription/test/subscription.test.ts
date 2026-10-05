import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { subscription } from "../src";
import { subscriptionClient } from "../src/client";
import type { Subscription } from "../src/types";
import { isSubscriptionActive } from "../src/utils";

const day = 86_400_000;
const plans = [{ name: "pro", limits: { projects: 10 } }];
const input = (
	referenceId: string,
	providerSubscriptionId = "membership-1",
) => ({
	provider: "paypal",
	providerSubscriptionId,
	referenceId,
	plan: "pro",
	status: "active" as const,
	periodStart: new Date(Date.now() - day),
	periodEnd: new Date(Date.now() + day),
	revision: 0,
});

describe("provider-independent subscriptions", () => {
	it("authenticates reads and keeps synchronization off the HTTP and client API", async () => {
		const { auth, client, signInWithTestUser } = await getTestInstance(
			{ plugins: [subscription({ plans })] },
			{ clientOptions: { plugins: [subscriptionClient()] } },
		);
		expect((await client.subscriptions.list()).error?.status).toBe(401);
		await expect(
			auth.api.listCustomerSubscriptions({ headers: new Headers() }),
		).rejects.toMatchObject({ status: "UNAUTHORIZED" });
		const { user, headers } = await signInWithTestUser();
		const result = await auth.api.syncSubscription({ body: input(user.id) });
		expect(result.applied).toBe(true);
		expect(await auth.api.listSubscriptionPlans({ headers })).toEqual(plans);
		expect(
			await client.subscriptions.list({
				fetchOptions: { headers, throw: true },
			}),
		).toMatchObject([
			{
				id: result.subscription.id,
				provider: "paypal",
				limits: { projects: 10 },
			},
		]);
		for (const path of ["/subscriptions/sync", "/sync-subscription"]) {
			const response = await auth.handler(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...input(user.id), revision: 99 }),
				}),
			);
			expect(response.status).toBe(404);
		}
		expectTypeOf<"syncSubscription">().not.toExtend<keyof typeof client>();
		expectTypeOf<"sync">().not.toExtend<keyof typeof client.subscriptions>();
	});

	it("uses absolute periods and ignores duplicate or older revisions", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans })],
		});
		const { user } = await signInWithTestUser();
		const body = input(user.id);
		const first = await auth.api.syncSubscription({ body });
		const repeated = await auth.api.syncSubscription({ body });
		expect(repeated).toMatchObject({
			applied: false,
			subscription: { id: first.subscription.id },
		});
		const extended = {
			...body,
			revision: 2,
			periodEnd: new Date(body.periodEnd.getTime() + day),
		};
		expect((await auth.api.syncSubscription({ body: extended })).applied).toBe(
			true,
		);
		const old = await auth.api.syncSubscription({
			body: { ...body, revision: 1, status: "canceled" },
		});
		expect(old).toMatchObject({
			applied: false,
			subscription: {
				revision: 2,
				status: "active",
				periodEnd: extended.periodEnd,
			},
		});
		const { adapter } = await auth.$context;
		expect(await adapter.count({ model: "subscription" })).toBe(1);
	});

	it("deduplicates concurrent inserts and keeps the highest concurrent revision in SQL", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans })],
		});
		const { user } = await signInWithTestUser();
		const body = input(user.id);
		await Promise.all(
			[0, 2, 1, 2].map((revision) =>
				auth.api.syncSubscription({ body: { ...body, revision } }),
			),
		);
		await Promise.all(
			[3, 5, 4].map((revision) =>
				auth.api.syncSubscription({ body: { ...body, revision } }),
			),
		);
		const { adapter } = await auth.$context;
		expect(await adapter.count({ model: "subscription" })).toBe(1);
		expect(
			await adapter.findOne<Subscription>({
				model: "subscription",
				where: [{ field: "referenceId", value: user.id }],
			}),
		).toMatchObject({ revision: 5 });
	});

	it("keeps different providers separate and rejects reassignment even on an old revision", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans })],
		});
		const { user, headers } = await signInWithTestUser();
		const body = input(user.id);
		await auth.api.syncSubscription({ body: { ...body, revision: 2 } });
		await auth.api.syncSubscription({
			body: { ...body, provider: "bank_transfer" },
		});
		await expect(
			auth.api.syncSubscription({
				body: { ...body, referenceId: "other-user" },
			}),
		).rejects.toMatchObject({ status: "CONFLICT" });
		await expect(
			auth.api.listCustomerSubscriptions({
				headers,
				query: { referenceId: "other-user" },
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(await auth.api.listCustomerSubscriptions({ headers })).toHaveLength(
			2,
		);
	});

	it("allows organization reads only through application authorization", async () => {
		const authorizeReference = vi.fn(
			({ referenceId }: { referenceId: string }) => referenceId === "team-1",
		);
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans, authorizeReference })],
		});
		const { headers } = await signInWithTestUser();
		await auth.api.syncSubscription({ body: input("team-1") });
		expect(
			await auth.api.listCustomerSubscriptions({
				headers,
				query: { referenceId: "team-1" },
			}),
		).toHaveLength(1);
		await expect(
			auth.api.listCustomerSubscriptions({
				headers,
				query: { referenceId: "team-2" },
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
		expect(authorizeReference).toHaveBeenCalledTimes(2);
	});

	it("excludes expired, future, canceled and unknown-plan grants while retaining history", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans })],
		});
		const { user, headers } = await signInWithTestUser();
		const now = Date.now();
		const body = input(user.id);
		await auth.api.syncSubscription({ body });
		await auth.api.syncSubscription({
			body: {
				...body,
				providerSubscriptionId: "expired",
				periodStart: new Date(now - 2 * day),
				periodEnd: new Date(now - day),
			},
		});
		await auth.api.syncSubscription({
			body: {
				...body,
				providerSubscriptionId: "future",
				periodStart: new Date(now + day),
				periodEnd: new Date(now + 2 * day),
			},
		});
		await auth.api.syncSubscription({
			body: { ...body, providerSubscriptionId: "canceled", status: "canceled" },
		});
		const { adapter } = await auth.$context;
		await adapter.create({
			model: "subscription",
			data: { ...body, providerSubscriptionId: "legacy", plan: "removed-plan" },
		});
		const active = await auth.api.listCustomerSubscriptions({ headers });
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({ limits: { projects: 10 } });
		expect(active[0]).not.toHaveProperty("syncKey");
		expect(active[0]).not.toHaveProperty("providerCustomerId");
		const history = await auth.api.listCustomerSubscriptions({
			headers,
			query: { activeOnly: false },
		});
		expect(history).toHaveLength(5);
		expect(history.filter((row) => row.limits !== undefined)).toHaveLength(1);
	});

	it("resolves dynamic plans without exposing provider-specific configuration", async () => {
		const loadPlans = vi.fn(async () => [
			{
				name: "pro",
				limits: { projects: 10 },
				priceId: "internal-price",
				group: "workspace",
			},
		]);
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans: loadPlans })],
		});
		const { user, headers } = await signInWithTestUser();
		expect(await auth.api.listSubscriptionPlans({ headers })).toEqual([
			{ name: "pro", limits: { projects: 10 }, group: "workspace" },
		]);
		await auth.api.syncSubscription({
			body: { ...input(user.id), plan: "PRO" },
		});
		expect(await auth.api.listCustomerSubscriptions({ headers })).toMatchObject(
			[{ plan: "pro" }],
		);
	});

	it("rejects invalid dates and unknown plans without creating records", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans })],
		});
		const { user } = await signInWithTestUser();
		const body = input(user.id);
		for (const invalid of [
			{ ...body, periodEnd: body.periodStart },
			{ ...body, plan: "missing" },
			{ ...body, revision: -1 },
			{ ...body, provider: "" },
			{ ...body, trialStart: body.periodEnd, trialEnd: body.periodStart },
		]) {
			await expect(
				auth.api.syncSubscription({ body: invalid }),
			).rejects.toBeDefined();
		}
		const { adapter } = await auth.$context;
		expect(await adapter.count({ model: "subscription" })).toBe(0);
	});

	it("does not suppress storage failures as duplicate synchronization", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [subscription({ plans })],
		});
		const { user } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		vi.spyOn(adapter, "create").mockRejectedValueOnce(
			new Error("storage unavailable"),
		);
		await expect(
			auth.api.syncSubscription({ body: input(user.id) }),
		).rejects.toThrow("storage unavailable");
	});

	it("ends entitlements at the exact period/trial/cancellation boundary", () => {
		const now = new Date();
		const active = input("user");
		expect(isSubscriptionActive(active, now)).toBe(true);
		expect(isSubscriptionActive({ ...active, periodEnd: now }, now)).toBe(
			false,
		);
		expect(isSubscriptionActive({ ...active, cancelAt: now }, now)).toBe(false);
		expect(isSubscriptionActive({ ...active, endedAt: now }, now)).toBe(false);
		expect(
			isSubscriptionActive(
				{ ...active, status: "trialing", trialEnd: now },
				now,
			),
		).toBe(false);
		expect(isSubscriptionActive({ status: "active" }, now)).toBe(false);
		const endingAtPeriodEnd = { ...active, cancelAtPeriodEnd: true };
		expect(isSubscriptionActive(endingAtPeriodEnd, now)).toBe(true);
	});
});
