import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createMediaEngineClient,
	mediaDerivativeSchema,
	mediaGenerationSchema,
	verifyMediaEngineEvent,
} from "../src/media-engine";

const soundtrack = {
	asset_id: "audio",
	content_revision: "audio-v1",
	start_seconds: 0,
	volume: 1,
	loop: true,
	duration: "video",
	audio_mode: "replace",
};
const derivative = {
	environment: "sandbox",
	id: "export",
	generation_id: "job",
	variant: "soundtrack",
	asset_id: "derived-video",
	status: "pending",
	reason_code: "",
	source_video_asset_id: "video",
	source_video_content_revision: "video-v1",
	rules_version: 1,
	soundtrack,
};
const asset = {
	environment: "sandbox",
	id: "derived-video",
	owner_scope: "user",
	external_user_id: "user",
	application_id: "app",
	content_revision: "derived-v1",
	revision: 1,
	kind: "video",
	mime_type: "video/mp4",
	size_bytes: 64,
	status: "ready",
	purpose: "output",
	inspection_status: "passed",
	moderation_status: "skipped",
	media_info: {},
	metadata: {},
	created_at: "2026-10-30T00:00:00Z",
};
const job = {
	environment: "sandbox",
	id: "job",
	external_user_id: "user",
	external_request_id: "request",
	revision: 2,
	status: "succeeded",
	delivery_status: "available",
	resolution: "deliverable",
	mock: true,
	assets: [],
	output: { asset_id: "video" },
};
const audioGrant = {
	url: "https://private.example/audio?signature=temporary",
	expires_in: 60,
	asset_id: "audio",
	content_revision: "audio-v1",
	mime_type: "audio/mpeg",
	soundtrack,
};
const upload = {
	url: "https://private.example/staging?signature=temporary",
	headers: { "Content-Type": "video/mp4" },
	expires_in: 60,
	max_size_bytes: 1000,
};

function fixture(result: unknown) {
	const calls: {
		path: string;
		method?: string;
		body: unknown;
		headers: Headers;
	}[] = [];
	const client = createMediaEngineClient({
		base_url: "https://engine.example",
		api_key: "server-only-key",
		expected_environment: "sandbox",
		fetch: async (input, init) => {
			const path = new URL(String(input)).pathname;
			calls.push({
				path,
				method: init?.method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				headers: new Headers(init?.headers),
			});
			return Response.json(
				path === "/v1/application"
					? {
							id: "app",
							user_scoped: true,
							media_permissions: [],
							environment: "sandbox",
						}
					: result,
			);
		},
	});
	return { client, calls };
}

describe("task-scoped soundtrack and derivative delivery", () => {
	it("retains a fixed soundtrack and accepts older generation responses", () => {
		expect(
			mediaGenerationSchema.parse({ ...job, soundtrack }).soundtrack,
		).toEqual(soundtrack);
		expect(
			mediaGenerationSchema.parse({ ...job, soundtrack: null }).soundtrack,
		).toBeNull();
		expect(mediaGenerationSchema.parse(job).soundtrack).toBeUndefined();
		for (const patch of [
			{ audio_mode: "mix" },
			{ start_seconds: 1 },
			{ volume: 0 },
			{ loop: false },
			{ duration: "audio" },
		])
			expect(
				mediaGenerationSchema.safeParse({
					...job,
					soundtrack: { ...soundtrack, ...patch },
				}).success,
			).toBe(false);
	});
	it("preserves the audio snapshot after signed webhook verification", async () => {
		const timestamp = String(Math.floor(Date.now() / 1000)),
			secret = "s".repeat(32);
		const body = new TextEncoder().encode(
			JSON.stringify({
				...job,
				soundtrack,
				event_version: 2,
				event_id: "event",
				event: "generation.succeeded",
				application_id: "app",
				generation_id: "job",
			}),
		);
		const headers = new Headers({
			"X-Media-Timestamp": timestamp,
			"X-Media-Event-ID": "event",
			"X-Media-Signature": `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`,
		});
		expect(
			(
				await verifyMediaEngineEvent({
					body,
					headers,
					secret,
					application_id: "app",
					expected_environment: "sandbox",
				})
			).soundtrack,
		).toEqual(soundtrack);
	});
	it("gets audio through its task route with verified user headers", async () => {
		const { client, calls } = fixture(audioGrant);
		expect(await client.soundtrackURL({ user_id: "user" }, "job/path")).toEqual(
			audioGrant,
		);
		expect(calls.map((call) => call.path)).toEqual([
			"/v1/application",
			"/v1/generations/job%2Fpath/soundtrack-url",
		]);
		expect(calls[1]?.headers.get("X-Media-User-ID")).toBe("user");
		expect(calls[1]?.headers.get("Authorization")).toBe(
			"Bearer server-only-key",
		);
	});
	it("lists derivatives without manufacturing a new generation or upload", async () => {
		const { client, calls } = fixture({ items: [derivative] });
		expect(
			(await client.derivatives({ user_id: "user" }, "job")).items,
		).toEqual([derivative]);
		expect(calls.at(-1)).toMatchObject({
			path: "/v1/generations/job/derivatives",
			method: "GET",
			body: undefined,
		});
	});
	it("prepares a bounded upload and accepts an already prepared result without a new grant", async () => {
		const { client, calls } = fixture({ derivative, upload });
		expect(
			await client.prepareDerivative({ user_id: "user" }, "job", {
				variant: "soundtrack",
				max_size_bytes: 1000,
			}),
		).toEqual({ derivative, upload });
		expect(calls.at(-1)).toMatchObject({
			method: "POST",
			body: { variant: "soundtrack", max_size_bytes: 1000 },
		});
		const ready = fixture({ derivative: { ...derivative, status: "ready" } });
		expect(
			(
				await ready.client.prepareDerivative({ user_id: "user" }, "job", {
					variant: "muted",
					max_size_bytes: 1000,
				})
			).upload,
		).toBeUndefined();
	});
	it("completes and reads a specific derivative through the original task scope", async () => {
		const complete = fixture({ ...derivative, status: "checking" });
		expect(
			(
				await complete.client.completeDerivative(
					{ user_id: "user" },
					"job/path",
					"export/path",
				)
			).status,
		).toBe("checking");
		expect(complete.calls.at(-1)).toMatchObject({
			path: "/v1/generations/job%2Fpath/derivatives/export%2Fpath/complete",
			method: "POST",
			body: {},
		});
		const grant = {
			derivative: { ...derivative, status: "ready" },
			asset,
			url: "https://private.example/export?signature=fresh",
			expires_in: 60,
		};
		const read = fixture(grant);
		expect(
			await read.client.derivativeURL({ user_id: "user" }, "job", "export"),
		).toEqual(grant);
		expect(read.calls.at(-1)?.path).toBe(
			"/v1/generations/job/derivatives/export/url",
		);
	});
	it.each([
		0,
		-1,
		1.1,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid upload cap %s before networking", async (max_size_bytes) => {
		const { client, calls } = fixture({ derivative, upload });
		await expect(async () =>
			client.prepareDerivative({ user_id: "user" }, "job", {
				variant: "muted",
				max_size_bytes,
			}),
		).rejects.toThrow();
		expect(calls).toEqual([]);
	});
	it("rejects invalid derivative states and recipes", () => {
		for (const patch of [
			{ status: "published" },
			{ rules_version: 2 },
			{ source_video_content_revision: "" },
		])
			expect(
				mediaDerivativeSchema.safeParse({ ...derivative, ...patch }).success,
			).toBe(false);
		expect(
			mediaDerivativeSchema.safeParse({ ...derivative, soundtrack: undefined })
				.success,
		).toBe(false);
		expect(
			mediaDerivativeSchema.safeParse({ ...derivative, variant: "muted" })
				.success,
		).toBe(false);
		expect(
			mediaDerivativeSchema.safeParse({
				...derivative,
				variant: "muted",
				soundtrack: null,
			}).success,
		).toBe(true);
	});
	it("checks derivative environments in lists and grants", async () => {
		const listed = fixture({ items: [{ ...derivative, environment: "live" }] });
		await expect(
			listed.client.derivatives({ user_id: "user" }, "job"),
		).rejects.toMatchObject({ code: "MEDIA_ENGINE_ENVIRONMENT_MISMATCH" });
		const prepared = fixture({
			derivative: { ...derivative, environment: "live" },
			upload,
		});
		await expect(
			prepared.client.prepareDerivative({ user_id: "user" }, "job", {
				variant: "muted",
				max_size_bytes: 1000,
			}),
		).rejects.toMatchObject({ code: "MEDIA_ENGINE_ENVIRONMENT_MISMATCH" });
	});
	it("keeps expired or withheld audio as errors and never retries a purchase", async () => {
		let calls = 0;
		const client = createMediaEngineClient({
			base_url: "https://engine.example",
			api_key: "key",
			fetch: async () => {
				calls++;
				return Response.json(
					{ error: { code: "soundtrack_unavailable" } },
					{ status: 410 },
				);
			},
		});
		await expect(
			client.soundtrackURL({ user_id: "user" }, "job"),
		).rejects.toMatchObject({ code: "soundtrack_unavailable", status: 410 });
		expect(calls).toBe(1);
	});
});
