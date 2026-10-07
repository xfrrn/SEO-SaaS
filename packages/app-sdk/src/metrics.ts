import type { AuthContext, BetterAuthRateLimitStorage } from "better-auth";
import { constantTimeEqual } from "better-auth/crypto";

/** Server environment variables; pass process.env, Deno env, or Worker bindings. */
export interface MetricsEnvironment extends Record<string, unknown> {
	APP_METRICS_ENABLED?: string;
	APP_METRICS_TOKEN?: string;
	APP_METRICS_SITE_ID?: string;
	APP_METRICS_RATE_LIMIT_PER_MINUTE?: string;
}

/** Fixed reporting windows, both half-open [from, to) and expressed in UTC. */
export interface MetricsSnapshot {
	siteId: string;
	generatedAt: string;
	timezone: "UTC";
	totalUsers: number;
	newUsers7d: number;
	paidUsersThisMonth: number;
	periods: {
		newUsers: { from: string; to: string };
		paidUsers: { from: string; to: string };
	};
}

/** Configure one site's database and its verified payment-count query. */
export interface MetricsOptions {
	env: MetricsEnvironment;
	auth: {
		$context: Promise<{ adapter: Pick<AuthContext["adapter"], "count"> }>;
	};
	/**
	 * Count distinct users with verified, positive successful payments in [from, to).
	 * Define refund handling in the application. Honor signal and database timeouts.
	 * Required when enabled; subscription status is not proof of payment.
	 */
	countPaidUsers?: (period: {
		from: Date;
		to: Date;
		signal: AbortSignal;
	}) => Promise<number>;
	/** Atomic shared limiter for replicas; failures deny access. */
	rateLimitStorage?: BetterAuthRateLimitStorage;
}

const minute = 60_000;
const day = 86_400_000;

function response(body: unknown, status = 200, headers?: HeadersInit) {
	const result = new Headers(headers);
	result.set("Cache-Control", "no-store");
	result.set("Vary", "Authorization");
	return Response.json(body, { status, headers: result });
}

function unavailable(retryAfter = 60) {
	return response({ error: "Metrics unavailable" }, 503, {
		"Retry-After": String(retryAfter),
	});
}

function rateLimited(retryAfter: number) {
	return response({ error: "Too many requests" }, 429, {
		"Retry-After": String(Math.max(1, Math.ceil(retryAfter))),
	});
}

// ponytail: these two bounded counters are per handler; use shared storage for replicas.
function localLimit(max: number) {
	let start = 0;
	let count = 0;
	return (now: number) => {
		if (!count || now - start >= minute) {
			start = now;
			count = 0;
		}
		if (count >= max)
			return Math.max(1, Math.ceil((start + minute - now) / 1000));
		count++;
		return 0;
	};
}

/**
 * Create once per site/runtime and mount on a dedicated server route (GET only).
 * Disabled unless APP_METRICS_ENABLED is exactly "true". No session or HTTP writes.
 * Counts the entire configured user database: siteId is a label, not a tenant filter.
 */
export function createMetricsHandler(options: MetricsOptions) {
	if (options.env.APP_METRICS_ENABLED !== "true") {
		return async (_request: Request): Promise<Response> =>
			response({ error: "Not found" }, 404);
	}
	const token = options.env.APP_METRICS_TOKEN;
	const siteId = options.env.APP_METRICS_SITE_ID;
	const countPaidUsers = options.countPaidUsers;
	if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
		throw new Error(
			"APP_METRICS_TOKEN must contain 32–256 random URL-safe characters",
		);
	}
	if (!siteId || !/^[A-Za-z0-9_-]{1,128}$/.test(siteId)) {
		throw new Error(
			"APP_METRICS_SITE_ID must contain 1–128 letters, digits, _ or -",
		);
	}
	if (typeof countPaidUsers !== "function") {
		throw new Error(
			"Enabled metrics require countPaidUsers from verified payment records",
		);
	}
	const rate = options.env.APP_METRICS_RATE_LIMIT_PER_MINUTE ?? "6";
	if (!/^[1-9]\d?$/.test(rate) || Number(rate) > 60) {
		throw new Error(
			"APP_METRICS_RATE_LIMIT_PER_MINUTE must be an integer from 1 to 60",
		);
	}
	const max = Number(rate);
	const attempts = localLimit(60);
	const authorized = localLimit(max);
	const storage = options.rateLimitStorage;
	let cache: { snapshot: MetricsSnapshot; expiresAt: number } | undefined;
	let running = false;
	let retryAt = 0;

	return async (request: Request): Promise<Response> => {
		const now = Date.now();
		const attemptRetry = attempts(now);
		if (attemptRetry) return rateLimited(attemptRetry);
		const authorization = request.headers.get("authorization") ?? "";
		const supplied = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(
			authorization,
		)?.[1];
		if (!supplied || !constantTimeEqual(token, supplied)) {
			return response({ error: "Unauthorized" }, 401, {
				"WWW-Authenticate": "Bearer",
			});
		}
		const authorizedRetry = authorized(now);
		if (authorizedRetry) return rateLimited(authorizedRetry);
		if (request.method !== "GET") {
			return response({ error: "Method not allowed" }, 405, { Allow: "GET" });
		}
		if (new URL(request.url).search) {
			return response({ error: "Query parameters are not supported" }, 400);
		}
		if (now < retryAt) return unavailable(Math.ceil((retryAt - now) / 1000));
		if (running) return unavailable(1);
		running = true;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("Metrics timed out"));
			}, 5_000);
		});
		const work = (async () => {
			if (storage) {
				const result = await storage.consume(`app-metrics:${siteId}`, {
					window: 60,
					max,
				});
				controller.signal.throwIfAborted();
				if (result.allowed !== true) {
					return rateLimited(
						Number.isFinite(result.retryAfter) && (result.retryAfter ?? 0) > 0
							? result.retryAfter!
							: 60,
					);
				}
			}
			if (cache && Date.now() < cache.expiresAt)
				return response(cache.snapshot);
			const { adapter } = await options.auth.$context;
			controller.signal.throwIfAborted();
			const asOf = new Date();
			const from = new Date(asOf.getTime() - 7 * day);
			const monthStart = new Date(
				Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1),
			);
			// Wait for every operation, even if one fails: do not unlock while queries run.
			const counts = await Promise.allSettled([
				Promise.resolve().then(() => adapter.count({ model: "user" })),
				Promise.resolve().then(() =>
					adapter.count({
						model: "user",
						where: [
							{ field: "createdAt", operator: "gte", value: from },
							{ field: "createdAt", operator: "lt", value: asOf },
						],
					}),
				),
				Promise.resolve().then(() =>
					countPaidUsers({
						from: new Date(monthStart),
						to: new Date(asOf),
						signal: controller.signal,
					}),
				),
			]);
			controller.signal.throwIfAborted();
			const [totalUsers, newUsers7d, paidUsersThisMonth] = counts.map(
				(result) => {
					if (result.status === "rejected") throw result.reason;
					if (!Number.isSafeInteger(result.value) || result.value < 0) {
						throw new Error("Invalid metrics count");
					}
					return result.value;
				},
			);
			const snapshot: MetricsSnapshot = {
				siteId,
				generatedAt: asOf.toISOString(),
				timezone: "UTC",
				totalUsers: totalUsers!,
				newUsers7d: newUsers7d!,
				paidUsersThisMonth: paidUsersThisMonth!,
				periods: {
					newUsers: { from: from.toISOString(), to: asOf.toISOString() },
					paidUsers: { from: monthStart.toISOString(), to: asOf.toISOString() },
				},
			};
			cache = {
				snapshot,
				expiresAt: Math.min(
					asOf.getTime() + minute,
					Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 1),
				),
			};
			return response(snapshot);
		})().finally(() => {
			// A response timeout cannot cancel all database drivers. Keep the lock until settled.
			running = false;
		});
		try {
			return await Promise.race([work, timeout]);
		} catch {
			retryAt = Date.now() + minute;
			return unavailable();
		} finally {
			clearTimeout(timer);
		}
	};
}
