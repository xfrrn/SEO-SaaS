import type { MonitorOptions } from "@app/business";
import {
	registrationClues,
	sendConfirmedPayment,
	sendConfirmedRegistration,
} from "monitor-analytics-sdk/server";

/** Environment values can be supplied explicitly on Workers, Deno and other hosts. */
export interface MonitorEnvironment {
	[key: string]: string | undefined;
}

/** Read APP_MONITOR_* once at startup. Disabled monitoring needs no configuration. */
export function createMonitorOptions({
	env = globalThis.process?.env ?? {},
}: {
	env?: MonitorEnvironment;
} = {}): MonitorOptions | undefined {
	if (!env.APP_MONITOR_ENABLED || env.APP_MONITOR_ENABLED === "false") return;
	if (env.APP_MONITOR_ENABLED !== "true")
		throw new Error("APP_MONITOR_ENABLED must be true or false");
	const siteId = env.APP_MONITOR_SITE_ID ?? "";
	const environment =
		env.APP_MONITOR_ENVIRONMENT ??
		(env.NODE_ENV === "production" ? "production" : "development");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(siteId))
		throw new Error("Invalid APP_MONITOR_SITE_ID");
	if (
		environment !== "production" &&
		environment !== "staging" &&
		environment !== "development"
	)
		throw new Error("Invalid APP_MONITOR_ENVIRONMENT");
	const endpoint = env.APP_MONITOR_ENDPOINT ?? "";
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error("Invalid APP_MONITOR_ENDPOINT");
	}
	const local =
		environment === "development" &&
		["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.pathname.endsWith("/v1/server-events")
	)
		throw new Error(
			"APP_MONITOR_ENDPOINT must be a Collector server-events URL without credentials or query parameters",
		);
	const token = env.APP_MONITOR_TOKEN ?? "";
	if (!/^[\x21-\x7e]{32,256}$/.test(token))
		throw new Error("Invalid APP_MONITOR_TOKEN");
	function strings(key: string, fallback?: string): string[] {
		let value: unknown;
		try {
			value = JSON.parse(env[key] ?? fallback ?? "");
		} catch {
			throw new Error(`Invalid ${key}`);
		}
		if (
			!Array.isArray(value) ||
			value.length > 1000 ||
			value.some((item) => typeof item !== "string")
		)
			throw new Error(`Invalid ${key}`);
		return value as string[];
	}
	const origins = strings("APP_MONITOR_ORIGINS_JSON");
	if (
		!origins.length ||
		origins.length > 100 ||
		origins.some((origin) => {
			try {
				const parsed = new URL(origin);
				return (
					!["http:", "https:"].includes(parsed.protocol) ||
					parsed.origin !== origin
				);
			} catch {
				return true;
			}
		})
	)
		throw new Error(
			"APP_MONITOR_ORIGINS_JSON must contain canonical website origins",
		);
	const allowedPaths = strings("APP_MONITOR_ALLOWED_PATHS_JSON", "[]");
	for (const path of allowedPaths) {
		const parsed = new URL(path, origins[0]);
		if (
			!path.startsWith("/") ||
			parsed.origin !== origins[0] ||
			parsed.pathname !== path ||
			parsed.search ||
			parsed.hash ||
			!registrationClues(
				{
					schema_version: 1,
					site_id: siteId,
					attribution: {
						first_touch: {
							kind: "unknown",
							occurred_at: "2026-01-01T00:00:00.000Z",
							landing_page: `${origins[0]}${path}`,
						},
					},
				},
				siteId,
				allowedPaths,
				origins,
			)
		)
			throw new Error("Invalid APP_MONITOR_ALLOWED_PATHS_JSON");
	}
	const retryDays = Number(env.APP_MONITOR_RETRY_WINDOW_DAYS ?? 7);
	const retentionDays = Number(env.APP_MONITOR_COLLECTOR_RETENTION_DAYS ?? 30);
	if (
		!Number.isSafeInteger(retryDays) ||
		retryDays < 1 ||
		!Number.isSafeInteger(retentionDays) ||
		retentionDays <= retryDays ||
		!Number.isSafeInteger(retentionDays * 86_400_000)
	)
		throw new Error(
			"Monitor retry window must be positive and shorter than Collector retention",
		);
	const parseContext = (value: unknown) =>
		registrationClues(value, siteId, allowedPaths, origins);
	const destination = { endpoint, token, origins, allowedPaths };
	return {
		siteId,
		environment,
		endpoint,
		retryWindowMs: retryDays * 86_400_000,
		parseContext,
		async send(event) {
			if (
				event.record.siteId !== siteId ||
				(event.record.attribution && !parseContext(event.record.attribution))
			)
				throw Object.assign(
					new Error("Saved monitor event no longer matches site policy"),
					{ code: "monitor_policy_changed" },
				);
			return event.type === "signup_confirmed"
				? sendConfirmedRegistration(event.record, destination)
				: sendConfirmedPayment(event.record, destination);
		},
	};
}

/** Start one non-overlapping round every minute in a persistent backend process. */
export function startMonitorWorker({
	auth,
	onError = () =>
		console.error(
			"[monitor] Delivery round failed; pending records will be recovered.",
		),
}: {
	auth: { api: { runMonitorDelivery: () => Promise<unknown> } };
	/** Receives no error body or credential. Persisted event failures are available in the panel. */
	onError?: () => void;
}) {
	let running: Promise<void> | undefined;
	let stopped = false;
	function run() {
		if (stopped || running !== undefined) return;
		running = Promise.resolve()
			.then(() => auth.api.runMonitorDelivery())
			.then(
				() => {},
				() => {
					try {
						onError();
					} catch {
						/* Logging must not stop the worker. */
					}
				},
			)
			.finally(() => {
				running = undefined;
			});
	}
	const timer = setInterval(run, 60_000);
	run();
	return {
		async stop() {
			stopped = true;
			clearInterval(timer);
			await running;
		},
	};
}
