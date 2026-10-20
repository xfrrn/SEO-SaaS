import { getTestInstance } from "better-auth/test";
import { vi } from "vitest";
import { createModerationConsents } from "../src/moderation/consents";
import { createModerationEvents } from "../src/moderation/events";
import { createModerationEvidence } from "../src/moderation/evidence";
import { createModerationMaintenance } from "../src/moderation/maintenance";
import { createModerationRuntime } from "../src/moderation/runtime";
import { moderationSchema } from "../src/moderation/schema";
import { createModerationStore } from "../src/moderation/storage";
import type {
	AttemptState,
	ModerationDecision,
	ModerationOptions,
	PlatformPolicy,
} from "../src/moderation/types";

export const context = {
	tenant_id: "tenant",
	subject_id: "subject",
	actor_id: "operator",
};
export const revision = "revision";
export const contextDigest = "a".repeat(64);
export async function setupLifecycle() {
	const instance = await getTestInstance(
		{ plugins: [{ id: "lifecycle-test", schema: moderationSchema }] },
		{ transaction: true },
	);
	const { adapter } = await instance.auth.$context;
	const storage = createModerationStore(adapter);
	const policy: PlatformPolicy = {
		version: "1",
		allow_empty_input: true,
		abuse_rules: [],
		rules: [
			{
				id: "violence",
				category: "violence",
				layer: "safety",
				stages: ["prompt", "input", "output", "presentation", "reuse"],
				modalities: ["text"],
				minimum_scope: "text.semantic",
				required: true,
				mode: "enforce",
				detector_ids: [],
				threshold: 0.8,
				block_level: "soft",
				public_description: "Violence is prohibited",
				action: null,
			},
		],
		limits: {
			max_items: 10,
			max_text_chars: 1000,
			max_page_size: 100,
			max_export_records: 1000,
			detector_timeout_ms: 1000,
			command_lease_ms: 2000,
			review_ttl_ms: 10_000,
			authorization_ttl_ms: 10_000,
			action_lease_ms: 10_000,
			action_retry_ms: 100,
			action_max_attempts: 3,
			retention_ms: 86_400_000,
		},
	};
	const options: ModerationOptions = {
		storage,
		detectors: [],
		boundary_timeout_ms: 1000,
		evidence_secret: "test-only-evidence-secret-at-least-32-characters",
		authorize: vi.fn(async () => {}),
		resolvePolicy: async () => ({ platform: policy }),
		resolveControls: async () => ({
			version: "1",
			block_all: false,
			disabled_detectors: [],
		}),
		resolveRestrictedSignal: async () => ({
			status: "none",
			source: "test",
			evidence_ref: null,
		}),
		validateContent: async () => {},
	};
	const runtime = createModerationRuntime(options);
	const service = {
		...createModerationEvents(runtime),
		...createModerationConsents(runtime),
		...createModerationMaintenance(runtime),
		...createModerationEvidence(runtime),
	};
	async function seedAttempt(overrides: Partial<AttemptState> = {}) {
		const data: AttemptState = {
			attempt_id: "attempt",
			job_id: "job",
			subject_id: context.subject_id,
			kind: "generation",
			stages: {},
			source_decision_ids: [],
			consent_ids: [],
			revoked: false,
			delivery_epoch: 0,
			provider_status: null,
			provider_event_id: null,
			outcome: null,
			created_at: new Date().toISOString(),
			...overrides,
		};
		return storage.transaction(context.tenant_id, (tx) =>
			tx.insert({
				kind: "attempt",
				key: data.attempt_id,
				subject_id: data.subject_id,
				attempt_id: data.attempt_id,
				data,
			}),
		);
	}
	async function seedDecision(overrides: Partial<ModerationDecision> = {}) {
		const prepared = await runtime.prepare(context, "evaluate");
		const data: ModerationDecision = {
			decision_id: crypto.randomUUID(),
			tenant_id: context.tenant_id,
			subject_id: context.subject_id,
			job_id: "job",
			attempt_id: "attempt",
			stage: "output",
			operation: "deliver",
			content_revision: revision,
			context_digest: contextDigest,
			policy_version: prepared.policy.version,
			capability_snapshot_id: prepared.capability_snapshot_id,
			findings: [],
			check_coverage: [],
			abuse_findings: [],
			decision: "allow",
			block_level: null,
			execution: "completed",
			created_at: new Date().toISOString(),
			enforcement: "continue",
			prerequisite_decision_ids: [],
			action_ids: [],
			mode: "enforce",
			would_decision: "allow",
			would_block_level: null,
			would_action_types: [],
			supersedes_decision_id: null,
			expires_at: null,
			...overrides,
		};
		await storage.transaction(context.tenant_id, async (tx) => {
			await runtime.snapshots(tx, prepared);
			await tx.insert({
				kind: "decision",
				key: data.decision_id,
				subject_id: data.subject_id,
				attempt_id: data.attempt_id,
				data,
			});
			const attempt = await tx.get<AttemptState>("attempt", data.attempt_id);
			if (!attempt) throw new Error("Seed an attempt first");
			await tx.replace(attempt, {
				...attempt.data,
				stages: {
					...attempt.data.stages,
					[data.stage]: {
						decision_id: data.decision_id,
						content_revision: data.content_revision,
						context_digest: data.context_digest,
					},
				},
			});
		});
		return data;
	}
	return {
		storage,
		options,
		policy,
		runtime,
		service,
		seedAttempt,
		seedDecision,
	};
}
