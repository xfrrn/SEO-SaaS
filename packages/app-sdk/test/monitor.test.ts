import { expect, it, vi } from "vitest";
import { createMonitorOptions, startMonitorWorker } from "../src/monitor";
import { monitorHeaders } from "../src/monitor/client";

const env = {
	APP_MONITOR_ENABLED: "true",
	APP_MONITOR_SITE_ID: "demo.site",
	APP_MONITOR_ENDPOINT: "https://collector.example/v1/server-events",
	APP_MONITOR_TOKEN: "test-only-credential-at-least-32-characters",
	APP_MONITOR_ORIGINS_JSON: '["https://tool.example"]',
	APP_MONITOR_ALLOWED_PATHS_JSON: '["/tools"]',
	APP_MONITOR_ENVIRONMENT: "staging",
};
const context = {
	schema_version: 1,
	site_id: "demo.site",
	attribution: {
		first_touch: {
			kind: "campaign",
			occurred_at: "2026-01-01T00:00:00.000Z",
			landing_page: "https://tool.example/tools",
			utm: { utm_source: "newsletter" },
		},
	},
};

it("creates bounded browser headers without failing a business request", () => {
	expect(monitorHeaders(undefined)).toEqual({});
	expect(monitorHeaders({})).toEqual({});
	expect(monitorHeaders({ ...context, attribution: "x".repeat(4096) })).toEqual(
		{},
	);
	const circular: Record<string, unknown> = { ...context };
	circular.attribution = circular;
	expect(monitorHeaders(circular)).toEqual({});
	const headers = monitorHeaders(context);
	expect(headers["X-Monitor-Context"]).toMatch(/^[A-Za-z0-9_-]+$/);
	expect(
		JSON.parse(
			atob(
				headers["X-Monitor-Context"]!.replaceAll("-", "+").replaceAll("_", "/"),
			),
		),
	).toEqual(context);
});

it("validates explicit site configuration and rejects unsafe Collector destinations", () => {
	expect(createMonitorOptions({ env: {} })).toBeUndefined();
	for (const patch of [
		{ APP_MONITOR_SITE_ID: "_invalid" },
		{ APP_MONITOR_TOKEN: "short" },
		{ APP_MONITOR_ENDPOINT: "http://collector.example/v1/server-events" },
		{
			APP_MONITOR_ENDPOINT:
				"https://collector.example/v1/server-events?token=private",
		},
		{
			APP_MONITOR_ENDPOINT:
				"https://user:secret@collector.example/v1/server-events",
		},
		{ APP_MONITOR_ORIGINS_JSON: "[]" },
		{ APP_MONITOR_ORIGINS_JSON: '["https://tool.example/path"]' },
		{ APP_MONITOR_ALLOWED_PATHS_JSON: '["/private?token=x"]' },
		{ APP_MONITOR_ENVIRONMENT: "preview" },
		{ APP_MONITOR_RETRY_WINDOW_DAYS: "30" },
	])
		expect(() => createMonitorOptions({ env: { ...env, ...patch } })).toThrow();
	const options = createMonitorOptions({ env })!;
	expect(options.parseContext(context)).toEqual(context);
	expect(
		options.parseContext({ ...context, site_id: "other" }),
	).toBeUndefined();
	expect(
		options.parseContext({ ...context, user_id: "forged" }),
	).toBeUndefined();
});

it("uses the packaged Monitor sender and refuses policy changes that would silently mutate an event", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(Response.json({ accepted: 0, duplicates: 1 }));
	try {
		const options = createMonitorOptions({ env })!;
		const record = {
			siteId: "demo.site",
			userId: "saved-user",
			orderId: "saved-order",
			amount: 990,
			currency: "USD",
			eventId: crypto.randomUUID(),
			occurredAt: new Date().toISOString(),
			environment: "staging" as const,
			attribution: context,
		};
		expect(await options.send({ type: "payment_confirmed", record })).toEqual({
			accepted: 0,
			duplicates: 1,
		});
		const request = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
		expect(request.events[0]).toMatchObject({
			capture_origin: "backend",
			event_type: "payment_confirmed",
			identity: { user_id: record.userId, order_id: record.orderId },
			props: { amount: 990, currency: "USD" },
		});
		const changed = createMonitorOptions({
			env: { ...env, APP_MONITOR_ALLOWED_PATHS_JSON: "[]" },
		})!;
		await expect(
			changed.send({ type: "payment_confirmed", record }),
		).rejects.toMatchObject({ code: "monitor_policy_changed" });
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		fetch.mockRestore();
	}
});

it("runs one background round at a time and stops without scheduling further work", async () => {
	vi.useFakeTimers();
	let resolve!: () => void;
	const runMonitorDelivery = vi.fn(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			}),
	);
	const worker = startMonitorWorker({ auth: { api: { runMonitorDelivery } } });
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(runMonitorDelivery).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(runMonitorDelivery).toHaveBeenCalledTimes(1);
		resolve();
		await worker.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(runMonitorDelivery).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});
