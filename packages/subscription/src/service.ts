import type { DBAdapter } from "@better-auth/core/db/adapter";
import { APIError } from "better-auth";
import * as z from "zod";
import type { SubscriptionOptions } from "./index";
import { createProductService, productPlanName } from "./product";
import type { Subscription, SubscriptionPlan } from "./types";
import { isSubscriptionActive, resolvePlans } from "./utils";

const identifier = z.string().trim().min(1).max(255);
/** Validate trusted absolute subscription periods and monotonic provider revisions. */
export const syncSubscriptionSchema = z
	.object({
		provider: z
			.string()
			.min(1)
			.max(255)
			.regex(/^[a-z][a-z0-9_-]*$/),
		providerSubscriptionId: identifier,
		providerCustomerId: identifier.nullable().optional(),
		referenceId: identifier,
		plan: identifier,
		status: z.enum([
			"active",
			"canceled",
			"incomplete",
			"incomplete_expired",
			"past_due",
			"paused",
			"trialing",
			"unpaid",
		]),
		periodStart: z.date(),
		periodEnd: z.date(),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		trialStart: z.date().nullable().optional(),
		trialEnd: z.date().nullable().optional(),
		cancelAtPeriodEnd: z.boolean().optional(),
		cancelAt: z.date().nullable().optional(),
		canceledAt: z.date().nullable().optional(),
		endedAt: z.date().nullable().optional(),
		seats: z
			.number()
			.int()
			.min(0)
			.max(Number.MAX_SAFE_INTEGER)
			.nullable()
			.optional(),
		billingInterval: z
			.enum(["day", "week", "month", "year"])
			.nullable()
			.optional(),
	})
	.refine((body) => body.periodStart < body.periodEnd, {
		message: "periodEnd must be after periodStart",
		path: ["periodEnd"],
	})
	.refine(
		(body) =>
			!body.trialStart || !body.trialEnd || body.trialStart < body.trialEnd,
		{ message: "trialEnd must be after trialStart", path: ["trialEnd"] },
	);

/** Trusted provider synchronization input; revisions must increase monotonically. */
export type SubscriptionSyncInput = z.input<typeof syncSubscriptionSchema>;

function publicSubscription(value: Subscription) {
	return {
		id: value.id,
		plan: value.plan,
		referenceId: value.referenceId,
		status: value.status,
		periodStart: value.periodStart,
		periodEnd: value.periodEnd,
		trialStart: value.trialStart,
		trialEnd: value.trialEnd,
		cancelAtPeriodEnd: value.cancelAtPeriodEnd,
		cancelAt: value.cancelAt,
		canceledAt: value.canceledAt,
		endedAt: value.endedAt,
		seats: value.seats,
		billingInterval: value.billingInterval,
		provider: value.provider,
	};
}

/** Reusable trusted-server subscription operations, without HTTP authorization. */
export function createSubscriptionService(
	adapter: Pick<
		DBAdapter,
		"create" | "findOne" | "findMany" | "count" | "updateMany"
	>,
	options: SubscriptionOptions,
) {
	async function configuredPlans() {
		const plans = await resolvePlans(options.plans ?? []);
		const names = new Set<string>();
		for (const plan of plans) {
			const name = plan.name.trim().toLowerCase();
			if (
				!name ||
				plan.name !== plan.name.trim() ||
				plan.name.length > 255 ||
				names.has(name)
			) {
				throw new APIError("BAD_REQUEST", {
					message:
						"Subscription plan names must be non-empty, unique, at most 255 characters, and have no leading or trailing whitespace",
				});
			}
			names.add(name);
		}
		return plans;
	}

	async function findPlan(
		name: string,
		configured?: SubscriptionPlan[],
	): Promise<SubscriptionPlan | undefined> {
		if (options.catalog && name.startsWith("product:")) {
			const product = await createProductService(adapter).get(name.slice(8));
			return product && product.type !== "credits"
				? { name: productPlanName(product), limits: product.limits }
				: undefined;
		}
		return (configured ?? (await configuredPlans())).find(
			(plan) => plan.name.toLowerCase() === name.toLowerCase(),
		);
	}
	async function plans(): Promise<SubscriptionPlan[]> {
		const result = [...(await configuredPlans())];
		if (!options.catalog) return result;
		const catalog = createProductService(adapter);
		for (let offset = 0; ; offset += 1000) {
			const products = await catalog.list({
				publishedOnly: true,
				limit: 1000,
				offset,
			});
			result.push(
				...products
					.filter((product) => product.type !== "credits")
					.map((product) => ({
						name: productPlanName(product),
						limits: product.limits,
					})),
			);
			if (products.length < 1000) return result;
		}
	}
	async function list(input: { referenceId: string; activeOnly?: boolean }) {
		const { referenceId, activeOnly } = z
			.object({
				referenceId: identifier,
				activeOnly: z.boolean().default(true),
			})
			.parse(input);
		const configured = await configuredPlans();
		const where = [{ field: "referenceId", value: referenceId }];
		const count = await adapter.count({ model: "subscription", where });
		const records = count
			? await adapter.findMany<Subscription>({
					model: "subscription",
					where,
					limit: count,
				})
			: [];
		const now = new Date();
		const rows = await Promise.all(
			records.map(async (value) => {
				const plan = await findPlan(value.plan, configured);
				const active = !!plan && isSubscriptionActive(value, now);
				return activeOnly && !active
					? null
					: {
							...publicSubscription(value),
							limits: active ? plan?.limits : undefined,
						};
			}),
		);
		return rows.filter((row) => row !== null);
	}
	async function sync(input: SubscriptionSyncInput) {
		const body = syncSubscriptionSchema.parse(input);
		const plan = await findPlan(body.plan);
		if (!plan) {
			throw new APIError("BAD_REQUEST", {
				message: "Unknown subscription plan",
			});
		}
		const syncKey = JSON.stringify([
			body.provider,
			body.providerSubscriptionId,
		]);
		const findByKey = () =>
			adapter.findOne<Subscription>({
				model: "subscription",
				where: [{ field: "syncKey", value: syncKey }],
			});
		const data = { ...body, plan: plan.name, syncKey };
		for (let attempt = 0; attempt < 5; attempt++) {
			const current =
				(await findByKey()) ??
				(await adapter.findOne<Subscription>({
					model: "subscription",
					where: [
						{ field: "provider", value: body.provider },
						{
							field: "providerSubscriptionId",
							value: body.providerSubscriptionId,
						},
					],
				}));
			if (current) {
				if (current.referenceId !== body.referenceId) {
					throw new APIError("CONFLICT", {
						message: "A subscription cannot change its referenceId",
					});
				}
				if (current.revision != null && current.revision >= body.revision) {
					return { subscription: current, applied: false };
				}
				const updated = await adapter.updateMany({
					model: "subscription",
					where: [
						{ field: "id", value: current.id },
						{ field: "revision", value: current.revision ?? null },
					],
					update: data,
				});
				if (updated) {
					const saved = await findByKey();
					if (saved) return { subscription: saved, applied: true };
				}
			} else {
				try {
					const saved = await adapter.create<typeof data, Subscription>({
						model: "subscription",
						data,
					});
					return { subscription: saved, applied: true };
				} catch (error) {
					if (!(await findByKey())) throw error;
				}
			}
		}
		throw new APIError("CONFLICT", {
			message: "Subscription changed concurrently; retry the synchronization",
		});
	}
	return { sync, list, plans };
}
