/** Public server-side moderation contracts. All time strings are UTC ISO 8601. */
export type Stage = "prompt" | "input" | "output" | "presentation" | "reuse";
export type Operation = "generate" | "publish" | "reuse" | "deliver";
export type AttemptKind = "generation" | "publication" | "reuse";
export type Layer =
	| "rules"
	| "safety"
	| "identity"
	| "rights"
	| "security"
	| "authenticity"
	| "abuse";
export type Modality = "text" | "image" | "audio" | "video";
export type Coverage =
	| "checked"
	| "unsupported"
	| "missing"
	| "skipped"
	| "failed"
	| "not_applicable";
export type Decision = "allow" | "review" | "block" | "legal_hold";
export type BlockLevel = "soft" | "hard" | null;
export type Mode = "enforce" | "shadow";

/** Identity and permission claims must be verified by the host, never the browser. */
export interface TrustedContext {
	tenant_id: string;
	subject_id: string;
	actor_id: string;
}
export type ContentItem = {
	item_id: string;
	field:
		| "prompt"
		| "media"
		| "title"
		| "description"
		| "alt"
		| "filename"
		| "share_copy";
	revision: string;
} & (
	| { modality: "text"; text: string }
	| { modality: "image" | "audio" | "video"; asset_ref: string }
);
export interface CheckRequest {
	context: TrustedContext;
	job_id: string | null;
	attempt_id: string | null;
	stage: Stage;
	layers: Layer[];
	categories: string[];
	items: ContentItem[];
	content_revision: string;
	context_digest: string;
	idempotency_key: string;
}
export interface EvaluationRequest {
	context: TrustedContext;
	job_id: string;
	attempt_id: string;
	attempt_kind: AttemptKind;
	stage: Stage;
	operation: Operation;
	items: ContentItem[];
	content_revision: string;
	context_digest: string;
	consent_ids: string[];
	source_decision_ids: string[];
	expected_state_revision: number;
	idempotency_key: string;
}
/** Scope is an explicit capability: text.rules never satisfies text.semantic. */
export interface PolicyRule {
	id: string;
	category: string;
	layer: Exclude<Layer, "abuse">;
	stages: Stage[];
	modalities: Modality[];
	minimum_scope: string;
	required: boolean;
	mode: Mode;
	detector_ids: string[];
	threshold: number | null;
	block_level: Exclude<BlockLevel, null>;
	public_description: string;
	action: "ban" | "revoke_session" | null;
}
export interface AbuseRule {
	id: string;
	metric: "requests" | "repeat_hits" | "edge_hits";
	window_ms: number;
	threshold: number;
	edge_score: number | null;
	effect: "limit" | "challenge" | "review";
	mode: Mode;
	identity: "account" | "ip" | "device" | "payment";
	parameters: Record<string, string | number | boolean>;
}
/** Numeric operating limits belong to versioned server configuration. */
export interface PolicyLimits {
	max_items: number;
	max_text_chars: number;
	max_page_size: number;
	max_export_records: number;
	detector_timeout_ms: number;
	command_lease_ms: number;
	review_ttl_ms: number;
	authorization_ttl_ms: number;
	action_lease_ms: number;
	action_retry_ms: number;
	action_max_attempts: number;
	retention_ms: number;
}
export interface PlatformPolicy {
	version: string;
	rules: PolicyRule[];
	abuse_rules: AbuseRule[];
	limits: PolicyLimits;
	allow_empty_input: boolean;
}
/** Tenants may add requirements; they cannot remove or override platform rules. */
export interface TenantPolicy {
	version: string;
	rules: PolicyRule[];
	abuse_rules: AbuseRule[];
}
export interface EffectivePolicy {
	version: string;
	platform_version: string;
	tenant_version: string;
	rules: PolicyRule[];
	abuse_rules: AbuseRule[];
	limits: PolicyLimits;
	allow_empty_input: boolean;
}
export interface Controls {
	version: string;
	block_all: boolean;
	disabled_detectors: string[];
}
export interface RequestedCheck {
	requested_check_id: string;
	item: ContentItem;
	rule: PolicyRule;
}
export interface Finding {
	finding_id: string;
	requested_check_id: string;
	item_id: string;
	modality: Modality;
	category: string;
	inspection_scope: string;
	coverage: Coverage;
	mode: Mode;
	decision: Decision | null;
	block_level: BlockLevel;
	detector_id: string | null;
	detector_version: string | null;
	provider_model: string | null;
	provider_request_id: string | null;
	native_category: string | null;
	native_flagged: boolean | null;
	score: number | null;
	threshold: number | null;
	rule_id: string | null;
	reason_code: string;
	media_evidence?: {
		video_plan: VideoInspectionPlan;
		video_manifest: VideoInspectionManifest;
	};
}
export interface DetectorFinding {
	requested_check_id: string;
	coverage: Coverage;
	flagged: boolean;
	score: number | null;
	reason_code: string;
	provider_model?: string;
	provider_request_id?: string;
	native_category?: string;
	media_evidence?: {
		video_plan: VideoInspectionPlan;
		video_manifest: VideoInspectionManifest;
	};
}
/** Detectors receive only their requested checks and a bounded abort signal. */
export interface ModerationDetector {
	id: string;
	version: string;
	layer: Exclude<Layer, "abuse">;
	capabilities: {
		modality: Modality;
		category: string;
		inspection_scope: string;
	}[];
	check(input: {
		items: ContentItem[];
		requested_checks: RequestedCheck[];
		signal: AbortSignal;
	}): Promise<DetectorFinding[]>;
}
export interface CheckCoverage {
	requested_check_id: string;
	item_id: string;
	category: string;
	modality: Modality;
	minimum_scope: string;
	mode: Mode;
	required: boolean;
	coverage: Coverage;
	finding_ids: string[];
	reason_code: string;
}
export interface AbuseFinding {
	rule_id: string;
	subject_ref: string;
	window_start: string;
	window_end: string;
	coverage: Coverage;
	observed_count: number | null;
	threshold: number | null;
	effect: "none" | "limit" | "challenge" | "review";
	evidence_event_ids: string[];
	mode: Mode;
	reason_code: string;
}
export interface CheckReport {
	report_id: string;
	tenant_id: string;
	subject_id: string;
	job_id: string | null;
	attempt_id: string | null;
	stage: Stage;
	content_revision: string;
	context_digest: string;
	policy_version: string;
	capability_snapshot_id: string;
	findings: Finding[];
	check_coverage: CheckCoverage[];
	abuse_findings: AbuseFinding[];
	decision: Decision;
	block_level: BlockLevel;
	execution: "completed" | "partial" | "error";
	created_at: string;
}
export interface ModerationDecision
	extends Omit<CheckReport, "report_id" | "job_id" | "attempt_id"> {
	decision_id: string;
	job_id: string;
	attempt_id: string;
	operation: Operation;
	enforcement: "continue" | "deny" | "quarantine";
	prerequisite_decision_ids: string[];
	action_ids: string[];
	mode: Mode;
	would_decision: Decision;
	would_block_level: BlockLevel;
	would_action_types: string[];
	supersedes_decision_id: string | null;
	expires_at: string | null;
}
export interface EvaluationResult {
	decision: ModerationDecision;
	state_revision: number;
}
export interface OperationAuthorization {
	authorization_id: string | null;
	attempt_id: string;
	operation: Operation;
	permit: boolean;
	decision_ids: string[];
	reason_code: string;
	expires_at: string | null;
}
export interface AuthorizeRequest {
	context: TrustedContext;
	attempt_id: string;
	operation: Operation;
	content_revision: string;
	context_digest: string;
	idempotency_key: string;
}
export interface ResolvedAbuseContext {
	account_ref: string;
	ip_digest: string | null;
	device_ref: string | null;
	payment_ref: string | null;
	source_version: string;
	observed_at: string;
}
export interface VideoInspectionPlan {
	version: string;
	frames_per_second: number;
	include_first_frame: boolean;
	include_last_frame: boolean;
	sample_scene_changes: boolean;
	include_audio: boolean;
	max_duration_ms: number;
	max_frames: number;
}
export interface VideoInspectionManifest {
	plan_version: string;
	extractor_version: string;
	asset_revision: string;
	actual_duration_ms: number;
	frames: { timestamp_ms: number; asset_ref: string }[];
	audio: { status: Coverage; transcript_ref: string | null };
	unmet_requirements: string[];
}
export interface AttemptState {
	attempt_id: string;
	job_id: string;
	subject_id: string;
	kind: AttemptKind;
	stages: Partial<
		Record<
			Stage,
			{ decision_id: string; content_revision: string; context_digest: string }
		>
	>;
	source_decision_ids: string[];
	consent_ids: string[];
	revoked: boolean;
	/** Only feedback targets can be cleared by reviewing that exact decision. */
	revoked_decision_ids?: string[];
	revocation_reasons?: string[];
	delivery_epoch: number;
	provider_status: "succeeded" | "policy_refused" | "technical_error" | null;
	provider_event_id: string | null;
	outcome: "accepted" | "refused" | "output_blocked" | null;
	created_at: string;
	stage_assets?: Partial<
		Record<Stage, { item_id: string; revision: string; asset_ref: string }[]>
	>;
}
export type ActionType = "limit" | "challenge" | "ban" | "revoke_session";
export interface EnforcementAction {
	action_id: string;
	subject_id: string;
	attempt_id: string;
	decision_id: string;
	rule_id: string;
	type: ActionType;
	parameters: Record<string, string | number | boolean>;
	status: "pending" | "succeeded" | "failed";
	attempts: number;
	lease_token: string | null;
	lease_until: string | null;
	next_attempt_at: string;
	expires_at: string;
	reason_code: string;
}
export interface ConsentDeclaration {
	consent_id: string;
	subject_id: string;
	actor_id: string;
	asset_digest: string;
	declaration_version: string;
	purposes: string[];
	expires_at: string;
	evidence_ref: string | null;
	status: "declared" | "verified" | "rejected" | "insufficient" | "revoked";
	revision: number;
	created_at: string;
}
export type * from "./host-types";
export type * from "./storage-types";
