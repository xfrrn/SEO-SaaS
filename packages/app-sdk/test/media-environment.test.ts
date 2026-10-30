import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import {
	createMediaEngineClient,
	verifyMediaEngineEvent,
} from "../src/media-engine";

const job = {
	id: "job",
	environment: "sandbox",
	external_user_id: "user",
	external_request_id: "request",
	revision: 1,
	status: "queued",
	delivery_status: "pending",
	resolution: "pending",
	mock: true,
	assets: [],
};
it("preserves sandbox identity, jobs, assets, and signed notifications", async () => {
	const client = createMediaEngineClient({
		base_url: "https://engine.example",
		api_key: "test-key",
		expected_environment: "sandbox",
		fetch: async (input) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v1/application")
				return Response.json({
					id: "app",
					user_scoped: true,
					media_permissions: [],
					environment: "sandbox",
				});
			return Response.json(job);
		},
	});
	expect((await client.application()).environment).toBe("sandbox");
	expect(
		(await client.generation({ user_id: "user" }, "job")).environment,
	).toBe("sandbox");
	const secret = "s".repeat(32),
		timestamp = String(Math.floor(Date.now() / 1000));
	const body = new TextEncoder().encode(
		JSON.stringify({
			...job,
			generation_id: job.id,
			application_id: "app",
			event_id: "event",
			event_version: 2,
			event: "generation.queued",
		}),
	);
	const input = {
		body,
		application_id: "app",
		secret,
		headers: new Headers({
			"X-Media-Timestamp": timestamp,
			"X-Media-Event-ID": "event",
			"X-Media-Signature":
				"sha256=" +
				createHmac("sha256", secret)
					.update(timestamp + ".")
					.update(body)
					.digest("hex"),
		}),
	};
	expect(
		(
			await verifyMediaEngineEvent({
				...input,
				expected_environment: "sandbox",
			})
		).environment,
	).toBe("sandbox");
	await expect(
		verifyMediaEngineEvent({ ...input, expected_environment: "live" }),
	).rejects.toMatchObject({ code: "MEDIA_ENGINE_ENVIRONMENT_MISMATCH" });
});
it.each([
	"live",
	undefined,
])("rejects a %s application before any sandbox upload or generation", async (environment) => {
	const paths: string[] = [];
	const client = createMediaEngineClient({
		base_url: "https://engine.example",
		api_key: "test-key",
		expected_environment: "sandbox",
		fetch: async (input) => {
			const path = new URL(String(input)).pathname;
			paths.push(path);
			return Response.json({
				id: "app",
				user_scoped: true,
				media_permissions: [],
				...(environment ? { environment } : {}),
			});
		},
	});
	await expect(
		client.generate(
			{ user_id: "user" },
			{
				external_request_id: "request",
				template_id: "tpl",
				version: 1,
				inputs: {},
			},
		),
	).rejects.toMatchObject({ code: "MEDIA_ENGINE_ENVIRONMENT_MISMATCH" });
	expect(paths).toEqual(["/v1/application"]);
});
it("rejects mismatched jobs and assets even with a correct application", async () => {
	const client = createMediaEngineClient({
		base_url: "https://engine.example",
		api_key: "test-key",
		expected_environment: "sandbox",
		fetch: async (input) => {
			const path = new URL(String(input)).pathname;
			if (path === "/v1/application")
				return Response.json({
					id: "app",
					user_scoped: true,
					media_permissions: [],
					environment: "sandbox",
				});
			if (path.startsWith("/v1/assets"))
				return Response.json({
					id: "asset",
					environment: "live",
					owner_scope: "user",
					content_revision: "1",
					revision: 1,
					kind: "image",
					mime_type: "image/png",
					size_bytes: 1,
					status: "ready",
					purpose: "input",
					inspection_status: "pending",
					moderation_status: "pending",
					media_info: {},
					metadata: {},
					created_at: "now",
				});
			return Response.json({ ...job, environment: "live" });
		},
	});
	await expect(
		client.generation({ user_id: "user" }, "job"),
	).rejects.toMatchObject({ code: "MEDIA_ENGINE_ENVIRONMENT_MISMATCH" });
	await expect(
		client.asset({ user_id: "user" }, "asset"),
	).rejects.toMatchObject({ code: "MEDIA_ENGINE_ENVIRONMENT_MISMATCH" });
});
