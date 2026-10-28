import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createMediaEngineClient,
	verifyMediaEngineEvent,
} from "../src/media-engine";

const job = {
	id: "gen_1",
	external_user_id: "user-1",
	external_request_id: "request-1",
	revision: 7,
	status: "succeeded",
	delivery_status: "available",
	resolution: "deliverable",
	mock: false,
	assets: [
		{ asset_id: "asset_1", role: "output", slot: "asset_id", position: 0 },
	],
	output: { asset_id: "asset_1" },
};
const event = {
	...job,
	event_version: 2,
	event_id: "evt_1",
	event: "generation.succeeded",
	application_id: "app_1",
	generation_id: job.id,
};
const secret = "private-application-secret-1234567890";
function signed(
	body = new TextEncoder().encode(JSON.stringify(event)),
	signingSecret = secret,
) {
	const timestamp = "1793094000";
	const mac = createHmac("sha256", signingSecret)
		.update(`${timestamp}.`)
		.update(body)
		.digest("hex");
	return {
		body,
		headers: new Headers({
			"X-Media-Event-ID": "evt_1",
			"X-Media-Timestamp": timestamp,
			"X-Media-Signature": `sha256=${mac}`,
		}),
		secret: signingSecret,
		application_id: "app_1",
		now_ms: 1793094000000,
	};
}
describe("media engine server client", () => {
	it("preserves unreviewed media and separate review, failure and reconciliation outcomes", async () => {
		const asset = {
			id: "asset_1",
			external_user_id: "user-1",
			owner_scope: "user",
			kind: "image",
			mime_type: "image/png",
			size_bytes: 128,
			status: "ready",
			purpose: "input",
			content_revision: "content-1",
			revision: 1,
			inspection_status: "passed",
			moderation_status: "skipped",
			created_at: "2026-10-28T00:00:00Z",
			media_info: {},
			metadata: {},
		};
		let response: unknown = asset;
		const client = createMediaEngineClient({
			base_url: "https://engine.fixture",
			api_key: "isolated-key",
			fetch: async () => Response.json(response),
		});
		expect(
			(await client.asset({ user_id: "user-1" }, "asset_1")).moderation_status,
		).toBe("skipped");
		for (const outcome of [
			{
				status: "running",
				delivery_status: "review",
				resolution: "pending",
				reason_code: "input_moderation_error",
			},
			{
				status: "failed",
				delivery_status: "blocked",
				resolution: "confirmed_no_delivery",
				reason_code: "output_moderation_blocked",
			},
			{
				status: "reconciling",
				delivery_status: "pending",
				resolution: "needs_reconciliation",
				reason_code: "submission_unknown",
			},
		]) {
			response = { ...job, ...outcome };
			const result = await client.generation({ user_id: "user-1" }, job.id);
			expect(result).toMatchObject(outcome);
		}
	});

	it("accepts both signing keys during an explicit overlap and rejects the expired old key", async () => {
		const original = signed();
		const current = "new-application-signing-secret-1234567890";
		const keyring = {
			current,
			previous: [
				{ secret, expires_at: new Date(original.now_ms + 1000).toISOString() },
			],
		};
		expect(
			(await verifyMediaEngineEvent({ ...original, secret: keyring })).event_id,
		).toBe("evt_1");
		expect(
			(
				await verifyMediaEngineEvent({
					...signed(undefined, current),
					secret: keyring,
				})
			).event_id,
		).toBe("evt_1");
		await expect(
			verifyMediaEngineEvent({
				...original,
				secret: keyring,
				now_ms: original.now_ms + 1000,
			}),
		).rejects.toMatchObject({ code: "MEDIA_WEBHOOK_INVALID" });
		expect(
			(
				await verifyMediaEngineEvent({
					...signed(undefined, current),
					secret: keyring,
					now_ms: original.now_ms + 1000,
				})
			).event_id,
		).toBe("evt_1");
		await expect(
			verifyMediaEngineEvent({
				...original,
				secret: { ...keyring, previous: [{ secret, expires_at: "never" }] },
			}),
		).rejects.toMatchObject({ code: "MEDIA_WEBHOOK_INVALID" });
	});
	it("encodes a Chinese review reason as a valid audited HTTP header", async () => {
		let reason = "";
		const client = createMediaEngineClient({
			base_url: "https://engine.example",
			api_key: "private-key",
			fetch: async (_url, init) => {
				reason = new Headers(init?.headers).get("X-Media-Access-Reason") ?? "";
				return Response.json({
					url: "https://r2.example/file",
					expires_in: 60,
					asset: {
						id: "a",
						owner_scope: "user",
						content_revision: "v1",
						revision: 1,
						kind: "image",
						mime_type: "image/png",
						size_bytes: 1,
						status: "ready",
						purpose: "input",
						inspection_status: "passed",
						moderation_status: "block",
						media_info: {},
						metadata: {},
						created_at: new Date().toISOString(),
					},
				});
			},
		});
		await client.assetURL(
			{ actor_id: "admin1", purpose: "review", reason: "核查用户申诉" },
			"a",
		);
		expect(decodeURIComponent(reason)).toBe("核查用户申诉");
	});
	it("binds business identity to server headers and one stable idempotency key", async () => {
		let observed: Request | undefined;
		const client = createMediaEngineClient({
			base_url: "https://engine.example",
			api_key: "private-key",
			fetch: async (url, init) => {
				observed = new Request(url, init);
				return Response.json(job);
			},
		});
		const result = await client.generate(
			{ user_id: "user-1" },
			{
				external_request_id: "request-1",
				template_id: "template-1",
				version: 1,
				inputs: { image: "asset-input" },
			},
		);
		expect(result.id).toBe("gen_1");
		expect(observed?.headers.get("Idempotency-Key")).toBe("request-1");
		expect(observed?.headers.get("X-Media-User-ID")).toBe("user-1");
		expect(await observed?.json()).toMatchObject({
			external_user_id: "user-1",
			external_request_id: "request-1",
		});
	});
	it("does not retry an uncertain paid request or expose upstream body secrets", async () => {
		let calls = 0;
		const client = createMediaEngineClient({
			base_url: "https://engine.example",
			api_key: "private-key",
			fetch: async () => {
				calls++;
				throw new Error("supplier-secret");
			},
		});
		await expect(
			client.generate(
				{ user_id: "user-1" },
				{
					external_request_id: "request-1",
					template_id: "template-1",
					version: 1,
					inputs: {},
				},
			),
		).rejects.toMatchObject({ message: "MEDIA_ENGINE_UNAVAILABLE" });
		expect(calls).toBe(1);
	});
	it("rejects unsafe origins, malformed responses and oversized results", async () => {
		expect(() =>
			createMediaEngineClient({
				base_url: "http://public.example",
				api_key: "key",
			}),
		).toThrow();
		const malformed = createMediaEngineClient({
			base_url: "https://engine.example",
			api_key: "key",
			fetch: async () => Response.json({ status: "succeeded" }),
		});
		await expect(
			malformed.generation({ user_id: "user-1" }, "gen_1"),
		).rejects.toMatchObject({ code: "MEDIA_ENGINE_CONTRACT_MISMATCH" });
		const oversized = createMediaEngineClient({
			base_url: "https://engine.example",
			api_key: "key",
			max_response_bytes: 1024,
			fetch: async () => new Response("x".repeat(1025)),
		});
		await expect(
			oversized.generation({ user_id: "user-1" }, "gen_1"),
		).rejects.toMatchObject({ code: "MEDIA_RESPONSE_TOO_LARGE" });
	});
	it("verifies exact raw bytes and rejects stale, changed or cross-application callbacks", async () => {
		expect((await verifyMediaEngineEvent(signed())).revision).toBe(7);
		const tampered = signed();
		tampered.body[tampered.body.length - 1] = 32;
		await expect(verifyMediaEngineEvent(tampered)).rejects.toMatchObject({
			code: "MEDIA_WEBHOOK_INVALID",
		});
		await expect(
			verifyMediaEngineEvent({ ...signed(), now_ms: 1793094400000 }),
		).rejects.toThrow();
		await expect(
			verifyMediaEngineEvent({ ...signed(), application_id: "other" }),
		).rejects.toMatchObject({ code: "MEDIA_WEBHOOK_BINDING_MISMATCH" });
		const header = signed();
		header.headers.set("X-Media-Event-ID", "different");
		await expect(verifyMediaEngineEvent(header)).rejects.toThrow();
	});
});
