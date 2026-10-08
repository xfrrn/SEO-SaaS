import type {
	DBAdapter,
	DBTransactionAdapter,
	Where,
} from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth";
import * as z from "zod";
import type { BusinessOrder } from "./types";
import { compositeKey, identifier, pagination } from "./validation";

/** Immutable, server-authored data passed to the optional monitoring sender. */
export interface MonitorRecord {
	siteId: string;
	userId: string;
	eventId: string;
	occurredAt: string;
	environment: "production" | "staging" | "development";
	attribution?: Record<string, unknown>;
}

/** The two confirmed business events supported by Monitor Analytics protocol v1. */
export type MonitorEvent =
	| {
			type: "signup_confirmed";
			record: MonitorRecord & { method: "email" | "oauth" };
	  }
	| {
			type: "payment_confirmed";
			record: MonitorRecord & {
				orderId: string;
				amount: number;
				currency: string;
			};
	  };

/** Configure through createMonitorOptions() in @app/auth-sdk/monitor. No sender runs inside a business transaction. */
export interface MonitorOptions {
	siteId: string;
	environment: MonitorRecord["environment"];
	endpoint: string;
	/** Defaults to seven days from the first delivery attempt. Must be below Collector retention. */
	retryWindowMs?: number;
	parseContext: (value: unknown) => Record<string, unknown> | undefined;
	send: (
		event: MonitorEvent,
	) => Promise<{ accepted: number; duplicates: number }>;
}

export interface MonitorSnapshot {
	siteId: string;
	environment: MonitorRecord["environment"];
	attribution?: Record<string, unknown>;
}

export type MonitorSignup = Omit<
	Extract<MonitorEvent, { type: "signup_confirmed" }>["record"],
	"userId"
>;

/** Persisted delivery state. Lease tokens and business keys are not exposed by administrative endpoints. */
export interface MonitorDelivery {
	id: string;
	eventId: string;
	eventKey: string;
	siteId: string;
	eventType: MonitorEvent["type"];
	userId: string;
	orderId: string | null;
	payload: MonitorEvent;
	status: "pending" | "processing" | "sent" | "failed" | "expired";
	attempts: number;
	nextAttemptAt: Date | null;
	firstAttemptAt: Date | null;
	lastAttemptAt: Date | null;
	leaseToken: string | null;
	leaseExpiresAt: Date | null;
	lastError: string | null;
	lastHttpStatus: number | null;
	deliveredAt: Date | null;
	createdAt: Date;
}

export const monitorQuery = pagination.extend({
	type: z.enum(["signup_confirmed", "payment_confirmed"]).optional(),
	status: z
		.enum(["pending", "processing", "sent", "failed", "expired"])
		.optional(),
	userId: identifier.optional(),
	orderId: identifier.optional(),
});

const day = 86_400_000;
const model = "businessMonitorEvent";
const retryWindow = (options: MonitorOptions) =>
	options.retryWindowMs ?? 7 * day;

/** Decode bounded, optional clues. Client data never supplies a trusted site, identity or event ID. */
export function monitorContext(
	options: MonitorOptions | undefined,
	headers?: Headers | null,
): MonitorSnapshot | undefined {
	if (!options) return;
	let attribution: Record<string, unknown> | undefined;
	try {
		const encoded = headers?.get("x-monitor-context");
		if (encoded && encoded.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(encoded)) {
			const bytes = Uint8Array.from(
				atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
				(char) => char.charCodeAt(0),
			);
			attribution = options.parseContext(
				JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
			);
		}
	} catch {
		/* Invalid analytics clues never fail the business request. */
	}
	return {
		siteId: options.siteId,
		environment: options.environment,
		...(attribution ? { attribution } : {}),
	};
}

function publicDelivery({
	leaseToken: _token,
	eventKey: _key,
	...event
}: MonitorDelivery) {
	return event;
}

/** Persist and deliver monitoring records using the site's existing SQL database. */
export function createMonitorService<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
	options?: MonitorOptions,
) {
	function enabled() {
		if (!options)
			throw new APIError("SERVICE_UNAVAILABLE", {
				message: "Monitoring is disabled",
			});
		return options;
	}
	const siteWhere = (): Where[] => [
		{ field: "siteId", value: enabled().siteId },
	];
	async function enqueue(
		event: MonitorEvent,
		eventKey: string,
		db: DBTransactionAdapter<Options> = adapter,
	) {
		await db.create({
			model,
			data: {
				eventId: event.record.eventId,
				eventKey,
				siteId: event.record.siteId,
				eventType: event.type,
				userId: event.record.userId,
				orderId:
					event.type === "payment_confirmed" ? event.record.orderId : null,
				payload: event,
				status: "pending",
				attempts: 0,
				nextAttemptAt: new Date(),
				firstAttemptAt: null,
				lastAttemptAt: null,
				leaseToken: null,
				leaseExpiresAt: null,
				lastError: null,
				lastHttpStatus: null,
				deliveredAt: null,
				createdAt: new Date(),
			},
		});
	}
	async function payment(
		db: DBTransactionAdapter<Options>,
		order: BusinessOrder & { monitorContext?: MonitorSnapshot | null },
	) {
		if (!options) return;
		const snapshot = order.monitorContext ?? {
			siteId: options.siteId,
			environment: options.environment,
		};
		await enqueue(
			{
				type: "payment_confirmed",
				record: {
					...snapshot,
					eventId: crypto.randomUUID(),
					userId: order.referenceId,
					orderId: order.id,
					occurredAt: order.paidAt!.toISOString(),
					amount: order.amount,
					currency: order.currency,
				},
			},
			await compositeKey(
				"monitor",
				snapshot.siteId,
				"payment",
				order.provider,
				order.paymentId!,
			),
			db,
		);
	}
	async function registrations() {
		const users = await adapter.findMany<{
			id: string;
			monitorSignup: MonitorSignup;
		}>({
			model: "user",
			where: [
				{ field: "monitorSignupPending", value: true },
				{ field: "monitorSiteId", value: enabled().siteId },
			],
			limit: 20,
			sortBy: { field: "createdAt", direction: "asc" },
		});
		for (const user of users) {
			await adapter.transaction(async (db) => {
				const count = await db.updateMany({
					model: "user",
					where: [
						{ field: "id", value: user.id },
						{ field: "monitorSignupPending", value: true },
						{ field: "monitorSiteId", value: enabled().siteId },
					],
					update: { monitorSignupPending: false },
				});
				if (!count) return;
				await enqueue(
					{
						type: "signup_confirmed",
						record: { ...user.monitorSignup, userId: user.id },
					},
					await compositeKey("monitor", enabled().siteId, "signup", user.id),
					db,
				);
			});
		}
	}
	async function deliver(event: MonitorDelivery) {
		const config = enabled();
		const now = new Date();
		const where: Where[] = [
			...siteWhere(),
			{ field: "id", value: event.id },
			{ field: "status", value: event.status },
			{ field: "attempts", value: event.attempts },
			{ field: "leaseToken", value: event.leaseToken },
			{
				field:
					event.status === "processing" ? "leaseExpiresAt" : "nextAttemptAt",
				value: now,
				operator: "lte",
			},
		];
		const expired =
			event.firstAttemptAt &&
			now.getTime() - event.firstAttemptAt.getTime() >= retryWindow(config);
		if (expired || (event.status === "processing" && event.attempts >= 8)) {
			await adapter.updateMany({
				model,
				where,
				update: {
					status: expired ? "expired" : "failed",
					lastError: expired
						? "monitor_retry_window_expired"
						: "monitor_attempts_exhausted",
					nextAttemptAt: null,
					leaseToken: null,
					leaseExpiresAt: null,
				},
			});
			return;
		}
		const leaseToken = crypto.randomUUID();
		const attempts = event.attempts + 1;
		if (
			!(await adapter.updateMany({
				model,
				where,
				update: {
					status: "processing",
					leaseToken,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
					attempts,
					firstAttemptAt: event.firstAttemptAt ?? now,
					lastAttemptAt: now,
				},
			}))
		)
			return;
		let update: Partial<MonitorDelivery>;
		try {
			const receipt = await config.send(structuredClone(event.payload));
			if (
				!receipt ||
				!Number.isSafeInteger(receipt.accepted) ||
				receipt.accepted < 0 ||
				!Number.isSafeInteger(receipt.duplicates) ||
				receipt.duplicates < 0 ||
				receipt.accepted + receipt.duplicates !== 1
			)
				throw Object.assign(new Error("Invalid Collector receipt"), {
					code: "collector_invalid_receipt",
				});
			update = {
				status: "sent",
				deliveredAt: new Date(),
				lastError: null,
				lastHttpStatus: null,
				nextAttemptAt: null,
			};
		} catch (error) {
			const failure =
				error && typeof error === "object"
					? (error as Record<string, unknown>)
					: {};
			const code =
				typeof failure.code === "string" &&
				[
					"collector_network_error",
					"collector_http_error",
					"collector_invalid_receipt",
					"collector_invalid_record",
					"monitor_policy_changed",
				].includes(failure.code)
					? failure.code
					: "monitor_delivery_error";
			const status =
				typeof failure.status === "number" &&
				Number.isInteger(failure.status) &&
				failure.status >= 400 &&
				failure.status <= 599
					? failure.status
					: null;
			const retryable =
				code === "collector_network_error" ||
				(code === "collector_http_error" &&
					(status === 429 || (status !== null && status >= 500)));
			const delay = Math.max(
				Math.min(60_000 * 2 ** (attempts - 1), 3_600_000),
				typeof failure.retryAfterMs === "number" &&
					Number.isFinite(failure.retryAfterMs)
					? Math.min(Math.max(0, failure.retryAfterMs), 7 * day)
					: 0,
			);
			const retry = retryable && attempts < 8;
			update = {
				status: retry ? "pending" : "failed",
				nextAttemptAt: retry ? new Date(Date.now() + delay) : null,
				lastError: code,
				lastHttpStatus: status,
			};
		}
		// A late response cannot overwrite another worker's newer lease or result.
		await adapter.updateMany({
			model,
			where: [
				...siteWhere(),
				{ field: "id", value: event.id },
				{ field: "leaseToken", value: leaseToken },
				{ field: "status", value: "processing" },
			],
			update: { ...update, leaseToken: null, leaseExpiresAt: null },
		});
	}
	async function drain() {
		if (!options) return { enabled: false, processed: 0 };
		await registrations();
		const now = new Date();
		const [abandoned, pending] = await Promise.all([
			adapter.findMany<MonitorDelivery>({
				model,
				where: [
					...siteWhere(),
					{ field: "status", value: "processing" },
					{ field: "leaseExpiresAt", value: now, operator: "lte" },
				],
				limit: 20,
				sortBy: { field: "leaseExpiresAt", direction: "asc" },
			}),
			adapter.findMany<MonitorDelivery>({
				model,
				where: [
					...siteWhere(),
					{ field: "status", value: "pending" },
					{ field: "nextAttemptAt", value: now, operator: "lte" },
				],
				limit: 20,
				sortBy: { field: "nextAttemptAt", direction: "asc" },
			}),
		]);
		// ponytail: bounded 20-event rounds suit site backends; use batch transport if delivery volume outgrows this limit.
		const events = [...abandoned, ...pending].slice(0, 20);
		let index = 0;
		const worker = async () => {
			while (index < events.length) await deliver(events[index++]!);
		};
		const results = await Promise.allSettled([worker(), worker()]);
		if (results.some((result) => result.status === "rejected"))
			throw new Error("Monitor delivery persistence failed");
		return { enabled: true, processed: events.length };
	}
	async function status() {
		if (!options) return { enabled: false as const };
		const states = [
			"pending",
			"processing",
			"sent",
			"failed",
			"expired",
		] as const;
		const counts = await Promise.all(
			states.map((state) =>
				adapter.count({
					model,
					where: [...siteWhere(), { field: "status", value: state }],
				}),
			),
		);
		const [last] = await adapter.findMany<MonitorDelivery>({
			model,
			where: [...siteWhere(), { field: "status", value: "sent" }],
			limit: 1,
			sortBy: { field: "deliveredAt", direction: "desc" },
		});
		return {
			enabled: true as const,
			siteId: options.siteId,
			environment: options.environment,
			endpoint: options.endpoint,
			credentialConfigured: true,
			counts: Object.fromEntries(
				states.map((state, index) => [state, counts[index]!]),
			) as Record<(typeof states)[number], number>,
			lastDeliveredAt: last?.deliveredAt ?? null,
			retryWindowMs: retryWindow(options),
		};
	}
	async function list(input: z.input<typeof monitorQuery> = {}) {
		const { type, status, userId, orderId, limit, offset } =
			monitorQuery.parse(input);
		const where: Where[] = siteWhere();
		for (const [field, value] of Object.entries({
			eventType: type,
			status,
			userId,
			orderId,
		}))
			if (value) where.push({ field, value });
		const [events, total] = await Promise.all([
			adapter.findMany<MonitorDelivery>({
				model,
				where,
				limit,
				offset,
				sortBy: { field: "createdAt", direction: "desc" },
			}),
			adapter.count({ model, where }),
		]);
		return { events: events.map(publicDelivery), total, limit, offset };
	}
	async function attribution(query: { userId?: string; orderId?: string }) {
		const config = enabled();
		const order = query.orderId
			? await adapter.findOne<
					BusinessOrder & { monitorContext?: MonitorSnapshot | null }
				>({
					model: "businessOrder",
					where: [{ field: "id", value: query.orderId }],
				})
			: null;
		const user = query.userId
			? await adapter.findOne<{ monitorSignup?: MonitorSignup | null }>({
					model: "user",
					where: [{ field: "id", value: query.userId }],
				})
			: null;
		if (!order && !user)
			throw new APIError("NOT_FOUND", {
				message: "Attribution subject not found",
			});
		const snapshot = order?.monitorContext ?? user?.monitorSignup;
		return {
			siteId: config.siteId,
			userId: order?.referenceId ?? query.userId,
			orderId: query.orderId,
			attribution:
				snapshot?.siteId === config.siteId
					? (snapshot.attribution ?? null)
					: null,
		};
	}
	async function retry(eventId: string, db = adapter) {
		const where = [...siteWhere(), { field: "eventId", value: eventId }];
		const event = await db.findOne<MonitorDelivery>({ model, where });
		if (!event)
			throw new APIError("NOT_FOUND", { message: "Monitor event not found" });
		if (
			event.status !== "failed" ||
			(event.firstAttemptAt &&
				Date.now() - event.firstAttemptAt.getTime() >= retryWindow(enabled()))
		)
			throw new APIError("CONFLICT", {
				message: "Only failed events within the retry window can be retried",
			});
		if (
			!(await db.updateMany({
				model,
				where: [...where, { field: "status", value: "failed" }],
				update: {
					status: "pending",
					nextAttemptAt: new Date(),
					leaseToken: null,
					leaseExpiresAt: null,
				},
			}))
		)
			throw new APIError("CONFLICT", { message: "Monitor event has changed" });
		return { eventId, status: "pending" as const };
	}
	return { payment, drain, status, list, attribution, retry };
}
