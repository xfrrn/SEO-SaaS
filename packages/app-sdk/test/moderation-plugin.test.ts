import { getTestInstance } from "better-auth/test";
import { describe, expect, it, vi } from "vitest";
import { createTextRulesDetector, moderation } from "../src/moderation";
import type { ModerationOptions } from "../src/moderation/types";
import {
	authorization,
	evaluation,
	fixtureText,
	platformPolicy,
	policyRule,
} from "./moderation-fixtures";

async function setupPlugin() {
	const authorize = vi.fn(async () => {});
	const options: Omit<ModerationOptions, "storage"> = {
		evidence_secret: "plugin-test-secret-012345678901234567890123456789",
		boundary_timeout_ms: 1000,
		authorize,
		detectors: [
			createTextRulesDetector({
				id: "fixture-detector",
				version: "plugin-rules-1",
				literal_terms: [
					{ term: "fixture blocked phrase", category: "violence" },
				],
			}),
		],
		resolvePolicy: async () => ({
			platform: platformPolicy({
				rules: [
					policyRule({
						layer: "rules",
						minimum_scope: "text.rules",
						threshold: null,
					}),
				],
			}),
		}),
		resolveControls: async () => ({
			version: "plugin-controls-1",
			block_all: false,
			disabled_detectors: [],
		}),
		resolveRestrictedSignal: async () => ({
			status: "none",
			source: "plugin-fixture",
			evidence_ref: null,
		}),
		validateContent: async () => {},
	};
	const plugin = moderation(options);
	const instance = await getTestInstance(
		{ plugins: [plugin] },
		{ transaction: true },
	);
	return { ...instance, plugin, authorize, options };
}

describe("moderation Better Auth bridge", () => {
	it("migrates plugin storage and exposes server APIs alongside the default authentication plugins", async () => {
		const { auth, signInWithTestUser, authorize } = await setupPlugin();
		const { adapter } = await auth.$context;
		expect(await adapter.count({ model: "moderationRecord" })).toBe(0);
		expect(await adapter.count({ model: "moderationTenantLock" })).toBe(0);
		const prompt = await auth.api.moderateContent({ body: evaluation() });
		expect(prompt.decision).toMatchObject({
			decision: "allow",
			enforcement: "continue",
		});
		expect(
			(await auth.api.authorizeModerationOperation({ body: authorization() }))
				.permit,
		).toBe(false);
		await auth.api.moderateContent({
			body: evaluation("input", prompt.state_revision),
		});
		const grant = await auth.api.authorizeModerationOperation({
			body: authorization("generate", { idempotency_key: "plugin-grant" }),
		});
		expect(grant).toMatchObject({ permit: true, operation: "generate" });
		expect(grant.authorization_id).toEqual(expect.any(String));
		expect(await adapter.count({ model: "moderationRecord" })).toBeGreaterThan(
			0,
		);
		expect(await adapter.count({ model: "moderationTenantLock" })).toBe(1);
		expect(authorize).toHaveBeenCalledWith(evaluation().context, "evaluate");
		expect(authorize).toHaveBeenCalledWith(evaluation().context, "authorize");
		const { headers, user } = await signInWithTestUser();
		expect((await auth.api.getSession({ headers }))?.user.id).toBe(user.id);
	});

	it("never registers moderation operations on HTTP, even for a signed-in user", async () => {
		const { auth, plugin, signInWithTestUser, authorize, options } =
			await setupPlugin();
		for (const endpoint of Object.values(plugin.endpoints)) {
			expect(endpoint.path).toBeUndefined();
			expect(endpoint.options).toMatchObject({
				metadata: { SERVER_ONLY: true },
			});
		}
		const { headers } = await signInWithTestUser();
		headers.set("origin", "http://localhost:3000");
		headers.set("content-type", "application/json");
		for (const path of [
			"moderate-content",
			"moderateContent",
			"moderation/evaluate",
			"authorize-moderation-operation",
			"authorizeModerationOperation",
		]) {
			const response = await auth.handler(
				new Request(`http://localhost:3000/api/auth/${path}`, {
					method: "POST",
					headers,
					body: JSON.stringify(evaluation()),
				}),
			);
			expect(response.status).toBe(404);
			const body = await response.text();
			expect(body).not.toContain(options.evidence_secret);
			expect(body).not.toContain(fixtureText.text);
		}
		expect(authorize).not.toHaveBeenCalled();
	});
});
