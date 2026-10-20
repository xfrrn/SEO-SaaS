import { getTestInstance } from "better-auth/test";
import { vi } from "vitest";
import { createModeration } from "../src/moderation";
import { moderationSchema } from "../src/moderation/schema";
import { createModerationStore } from "../src/moderation/storage";
import type {
	AuthorizeRequest,
	ContentItem,
	EvaluationRequest,
	ModerationDetector,
	ModerationOptions,
	PlatformPolicy,
	PolicyRule,
	Stage,
	TenantPolicy,
	TrustedContext,
} from "../src/moderation/types";

export const context: TrustedContext = {
	tenant_id: "tenant-one",
	subject_id: "subject-one",
	actor_id: "actor-one",
};
export const contextDigest = "a".repeat(64);
export const fixtureText = {
	item_id: "prompt-text",
	revision: "revision-1",
	field: "prompt",
	modality: "text",
	text: "ordinary fixture text",
} satisfies ContentItem;
export function policyRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
	return {
		id: "baseline-violence",
		category: "violence",
		layer: "safety",
		stages: ["prompt", "input", "output", "presentation", "reuse"],
		modalities: ["text"],
		minimum_scope: "text.semantic",
		required: true,
		mode: "enforce",
		detector_ids: ["fixture-detector"],
		threshold: 0.8,
		block_level: "soft",
		public_description: "Violence is prohibited",
		action: null,
		...overrides,
	};
}
export function platformPolicy(
	overrides: Partial<PlatformPolicy> = {},
): PlatformPolicy {
	return {
		version: "platform-1",
		rules: [policyRule()],
		abuse_rules: [],
		allow_empty_input: true,
		limits: {
			max_items: 20,
			max_text_chars: 10000,
			max_page_size: 100,
			max_export_records: 100,
			detector_timeout_ms: 100,
			command_lease_ms: 1000,
			review_ttl_ms: 1000,
			authorization_ttl_ms: 1000,
			action_lease_ms: 1000,
			action_retry_ms: 1000,
			action_max_attempts: 3,
			retention_ms: 86400000,
		},
		...overrides,
	};
}
export function evaluation(
	stage: Stage = "prompt",
	expected_state_revision = 0,
	overrides: Partial<EvaluationRequest> = {},
): EvaluationRequest {
	return {
		context,
		job_id: "job-one",
		attempt_id: "attempt-one",
		attempt_kind: "generation",
		stage,
		operation: stage === "prompt" || stage === "input" ? "generate" : "publish",
		items: [
			{
				...fixtureText,
				item_id: `${stage}-text`,
				field:
					stage === "presentation"
						? "title"
						: stage === "prompt"
							? "prompt"
							: "description",
			},
		],
		content_revision: "content-1",
		context_digest: contextDigest,
		consent_ids: [],
		source_decision_ids: [],
		expected_state_revision,
		idempotency_key: `evaluate-${stage}`,
		...overrides,
	};
}
export function authorization(
	operation: AuthorizeRequest["operation"] = "generate",
	overrides: Partial<AuthorizeRequest> = {},
): AuthorizeRequest {
	return {
		context,
		attempt_id: "attempt-one",
		operation,
		content_revision: "content-1",
		context_digest: contextDigest,
		idempotency_key: `authorize-${operation}`,
		...overrides,
	};
}
export async function setupModeration(
	input: {
		platform?: PlatformPolicy;
		tenant?: TenantPolicy;
		options?: Partial<Omit<ModerationOptions, "storage">>;
	} = {},
) {
	const instance = await getTestInstance(
		{ plugins: [{ id: "moderation-fixture", schema: moderationSchema }] },
		{ transaction: true, disableTestUser: true },
	);
	const { adapter } = await instance.auth.$context;
	const storage = createModerationStore(adapter);
	const check = vi.fn<ModerationDetector["check"]>(
		async ({ requested_checks }) =>
			requested_checks.map(({ requested_check_id, item, rule }) => {
				const flagged =
					item.modality === "text" &&
					item.text.includes(`block:${rule.category}`);
				return {
					requested_check_id,
					coverage: "checked",
					flagged,
					score: flagged ? 0.95 : 0.05,
					reason_code: flagged ? "FIXTURE_FLAGGED" : "FIXTURE_CLEAR",
				};
			}),
	);
	const authorize = vi.fn(async () => {});
	const platform = input.platform ?? platformPolicy();
	const options: ModerationOptions = {
		storage,
		boundary_timeout_ms: 1000,
		evidence_secret: "fixture-secret-012345678901234567890123456789",
		detectors: [
			{
				id: "fixture-detector",
				version: "fixture-1",
				layer: "safety",
				capabilities: ["violence", "sexual"].map((category) => ({
					modality: "text",
					category,
					inspection_scope: "text.semantic",
				})),
				check,
			},
		],
		authorize,
		resolvePolicy: async () => ({
			platform,
			...(input.tenant ? { tenant: input.tenant } : {}),
		}),
		resolveControls: async () => ({
			version: "controls-1",
			block_all: false,
			disabled_detectors: [],
		}),
		resolveRestrictedSignal: async () => ({
			status: "none",
			source: "fixture",
			evidence_ref: null,
		}),
		validateContent: async () => {},
		...input.options,
	};
	return {
		sdk: createModeration(options),
		storage,
		options,
		check,
		authorize,
		instance,
		platform,
	};
}
