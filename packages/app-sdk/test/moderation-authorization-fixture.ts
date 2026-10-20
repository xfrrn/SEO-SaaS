import { getTestInstance } from "better-auth/test";
import { createModerationAuthorization } from "../src/moderation/authorization";
import { createModerationRuntime } from "../src/moderation/runtime";
import { moderationSchema } from "../src/moderation/schema";
import { createModerationStore } from "../src/moderation/storage";
import type {
	AttemptState,
	AuthorizeRequest,
	Controls,
	ModerationDecision,
	ModerationOptions,
	PlatformPolicy,
	Stage,
	TrustedContext,
} from "../src/moderation/types";

export const context: TrustedContext = {
	tenant_id: "tenant",
	subject_id: "subject",
	actor_id: "actor",
};
const digest = "a".repeat(64);
export const future = () => new Date(Date.now() + 60_000).toISOString();
export const past = () => new Date(Date.now() - 60_000).toISOString();

export async function setup() {
	const instance = await getTestInstance(
		{
			plugins: [
				{ id: "moderation-authorization-test", schema: moderationSchema },
			],
		},
		{ transaction: true },
	);
	const { adapter } = await instance.auth.$context;
	const storage = createModerationStore(adapter);
	const platform: PlatformPolicy = {
		version: "v1",
		allow_empty_input: true,
		abuse_rules: [],
		rules: [
			{
				id: "required",
				category: "sexual",
				layer: "safety",
				stages: ["prompt", "input", "output", "presentation", "reuse"],
				modalities: ["text"],
				minimum_scope: "text.semantic",
				required: true,
				mode: "enforce",
				detector_ids: [],
				threshold: 0.8,
				block_level: "soft",
				public_description: "No sexual content",
				action: null,
			},
		],
		limits: {
			max_items: 10,
			max_text_chars: 1000,
			max_page_size: 50,
			max_export_records: 100,
			detector_timeout_ms: 100,
			command_lease_ms: 1000,
			review_ttl_ms: 60_000,
			authorization_ttl_ms: 30_000,
			action_lease_ms: 1000,
			action_retry_ms: 1000,
			action_max_attempts: 3,
			retention_ms: 60_000,
		},
	};
	const controls: Controls = {
		version: "v1",
		block_all: false,
		disabled_detectors: [],
	};
	const options: ModerationOptions = {
		storage,
		detectors: [],
		boundary_timeout_ms: 1000,
		evidence_secret: "test-evidence-secret-at-least-32-characters",
		authorize: async () => {},
		resolvePolicy: async () => ({ platform }),
		resolveControls: async () => controls,
		resolveRestrictedSignal: async () => ({
			status: "none",
			source: "test",
			evidence_ref: null,
		}),
		validateContent: async () => {},
		validateConsent: async () => {},
	};
	const runtime = createModerationRuntime(options);
	const service = createModerationAuthorization(runtime);
	const seed = async (
		stages: Stage[] = ["prompt", "input"],
		patch: Partial<AttemptState> = {},
		decisionPatch: Partial<ModerationDecision> = {},
	) => {
		const prepared = await runtime.prepare(context, "authorize");
		const state: AttemptState = {
			attempt_id: "attempt",
			job_id: "job",
			subject_id: "subject",
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
			...patch,
		};
		await storage.transaction("tenant", async (tx) => {
			for (const stage of stages) {
				const decision: ModerationDecision = {
					decision_id: `${state.attempt_id}-${stage}`,
					tenant_id: "tenant",
					subject_id: state.subject_id,
					job_id: state.job_id,
					attempt_id: state.attempt_id,
					stage,
					operation:
						stage === "prompt" ||
						(stage === "input" && state.kind === "generation")
							? "generate"
							: stage === "reuse"
								? "reuse"
								: "publish",
					content_revision: stage,
					context_digest: digest,
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
					prerequisite_decision_ids: Object.values(state.stages).map(
						(entry) => entry.decision_id,
					),
					action_ids: [],
					mode: "enforce",
					would_decision: "allow",
					would_block_level: null,
					would_action_types: [],
					supersedes_decision_id: null,
					expires_at: null,
					...decisionPatch,
				};
				state.stages[stage] = {
					decision_id: decision.decision_id,
					content_revision: decision.content_revision,
					context_digest: decision.context_digest,
				};
				await tx.insert({
					kind: "decision",
					key: decision.decision_id,
					subject_id: state.subject_id,
					attempt_id: state.attempt_id,
					data: decision,
				});
			}
			return tx.insert({
				kind: "attempt",
				key: state.attempt_id,
				subject_id: state.subject_id,
				attempt_id: state.attempt_id,
				data: state,
			});
		});
		return state;
	};
	const request = (
		patch: Partial<AuthorizeRequest> = {},
	): AuthorizeRequest => ({
		context,
		attempt_id: "attempt",
		operation: "generate",
		content_revision: "input",
		context_digest: digest,
		idempotency_key: crypto.randomUUID(),
		...patch,
	});
	return {
		storage,
		options,
		runtime,
		service,
		platform,
		controls,
		seed,
		request,
	};
}
