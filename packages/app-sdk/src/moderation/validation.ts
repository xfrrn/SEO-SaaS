import * as z from "zod";
import { digest, moderationError } from "./primitives";
import type { EffectivePolicy, PlatformPolicy, TenantPolicy } from "./types";

export const moderationCategories = [
	"nudity",
	"sexual",
	"sexual/minors",
	"sexual/fetish",
	"sexual/clothed",
	"non-consensual-nudity",
	"violence",
	"violence/graphic",
	"self-harm",
	"self-harm/intent",
	"self-harm/instructions",
	"hate",
	"hate/threatening",
	"harassment",
	"harassment/threatening",
	"illicit",
	"illicit/violent",
	"terrorism",
	"face-swap",
	"face-clone",
	"voice-clone",
	"impersonation",
	"public-figure",
	"misinformation",
	"copyright/character",
	"copyright/music",
	"copyright/material",
	"prompt-injection",
] as const;
export const identifier = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
export const contextSchema = z.strictObject({
	tenant_id: identifier,
	subject_id: identifier,
	actor_id: identifier,
});
const stage = z.enum(["prompt", "input", "output", "presentation", "reuse"]);
const layer = z.enum([
	"rules",
	"safety",
	"identity",
	"rights",
	"security",
	"authenticity",
	"abuse",
]);
const modality = z.enum(["text", "image", "audio", "video"]);
const operation = z.enum(["generate", "publish", "reuse", "deliver"]);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const itemBase = {
	item_id: identifier,
	field: z.enum([
		"prompt",
		"media",
		"title",
		"description",
		"alt",
		"filename",
		"share_copy",
	]),
	revision: identifier,
};
export const contentItemSchema = z.discriminatedUnion("modality", [
	z.strictObject({
		...itemBase,
		modality: z.literal("text"),
		text: z.string().min(1),
	}),
	z.strictObject({
		...itemBase,
		modality: z.literal("image"),
		asset_ref: identifier,
	}),
	z.strictObject({
		...itemBase,
		modality: z.literal("audio"),
		asset_ref: identifier,
	}),
	z.strictObject({
		...itemBase,
		modality: z.literal("video"),
		asset_ref: identifier,
	}),
]);
const base = {
	context: contextSchema,
	stage,
	items: z.array(contentItemSchema),
	content_revision: identifier,
	context_digest: z.string().regex(/^[a-f0-9]{64}$/),
	idempotency_key: identifier,
};
export const checkSchema = z
	.strictObject({
		...base,
		job_id: identifier.nullable(),
		attempt_id: identifier.nullable(),
		layers: z.array(layer).min(1),
		categories: z.array(z.enum(moderationCategories)).min(1),
	})
	.refine(
		(input) => (input.job_id === null) === (input.attempt_id === null),
		"Job and attempt must both be present or absent",
	);
export const evaluationSchema = z.strictObject({
	...base,
	job_id: identifier,
	attempt_id: identifier,
	attempt_kind: z.enum(["generation", "publication", "reuse"]),
	operation,
	consent_ids: z.array(identifier),
	source_decision_ids: z.array(identifier),
	expected_state_revision: z.number().int().nonnegative(),
});
export const authorizationSchema = z.strictObject({
	context: contextSchema,
	attempt_id: identifier,
	operation,
	content_revision: identifier,
	context_digest: z.string().regex(/^[a-f0-9]{64}$/),
	idempotency_key: identifier,
});
export const controlsSchema = z.strictObject({
	version: identifier,
	block_all: z.boolean(),
	disabled_detectors: z.array(identifier),
});
const ruleSchema = z.strictObject({
	id: identifier,
	category: z.enum(moderationCategories),
	layer: layer.exclude(["abuse"]),
	stages: z.array(stage).min(1),
	modalities: z.array(modality).min(1),
	minimum_scope: identifier,
	required: z.boolean(),
	mode: z.enum(["enforce", "shadow"]),
	detector_ids: z.array(identifier),
	threshold: z.number().finite().min(0).max(1).nullable(),
	block_level: z.enum(["soft", "hard"]),
	public_description: z.string().min(1).max(2000),
	action: z.enum(["ban", "revoke_session"]).nullable(),
});
const abuseSchema = z.strictObject({
	id: identifier,
	metric: z.enum(["requests", "repeat_hits", "edge_hits"]),
	window_ms: positive,
	threshold: positive,
	edge_score: z.number().min(0).max(1).nullable(),
	effect: z.enum(["limit", "challenge", "review"]),
	mode: z.enum(["enforce", "shadow"]),
	identity: z.enum(["account", "ip", "device", "payment"]),
	parameters: z.record(
		z.string(),
		z.union([z.string(), z.number().finite(), z.boolean()]),
	),
});
const limitsSchema = z.strictObject({
	max_items: positive.max(1000),
	max_text_chars: positive,
	max_page_size: positive.max(1000),
	max_export_records: positive.max(10_000),
	detector_timeout_ms: positive.max(2_147_483_647),
	command_lease_ms: positive.max(2_147_483_647),
	review_ttl_ms: positive,
	authorization_ttl_ms: positive,
	action_lease_ms: positive,
	action_retry_ms: positive,
	action_max_attempts: positive,
	retention_ms: positive,
});
const platformSchema = z.strictObject({
	version: identifier,
	rules: z.array(ruleSchema).min(1),
	abuse_rules: z.array(abuseSchema),
	limits: limitsSchema,
	allow_empty_input: z.boolean(),
});
const tenantSchema = z.strictObject({
	version: identifier,
	rules: z.array(ruleSchema),
	abuse_rules: z.array(abuseSchema),
});

/** Tenant policy is additive, so it cannot weaken the immutable platform floor. */
export async function effectivePolicy(input: {
	platform: PlatformPolicy;
	tenant?: TenantPolicy;
}): Promise<EffectivePolicy> {
	const platform = platformSchema.parse(input.platform);
	const tenant = input.tenant
		? tenantSchema.parse(input.tenant)
		: { version: "none", rules: [], abuse_rules: [] };
	if (
		platform.rules.some((rule) => !rule.required || rule.mode !== "enforce") ||
		platform.abuse_rules.some((rule) => rule.mode !== "enforce")
	)
		throw moderationError(
			"INVALID_POLICY",
			"Platform baseline rules must be enforced",
		);
	const rules = [...platform.rules, ...tenant.rules];
	const abuse_rules = [...platform.abuse_rules, ...tenant.abuse_rules];
	if (
		new Set([...rules, ...abuse_rules].map((rule) => rule.id)).size !==
		rules.length + abuse_rules.length
	)
		throw moderationError(
			"INVALID_POLICY",
			"Moderation rule identifiers must be unique",
		);
	if (
		rules.some(
			(rule) =>
				rule.category === "sexual/minors" &&
				(rule.block_level !== "hard" || rule.mode !== "enforce"),
		)
	)
		throw moderationError(
			"INVALID_POLICY",
			"Child safety cannot use soft or shadow enforcement",
		);
	if (platform.limits.command_lease_ms <= platform.limits.detector_timeout_ms)
		throw moderationError(
			"INVALID_POLICY",
			"Command lease must outlast the detector deadline",
		);
	return {
		version: await digest({ platform, tenant }),
		platform_version: platform.version,
		tenant_version: tenant.version,
		rules,
		abuse_rules,
		limits: platform.limits,
		allow_empty_input: platform.allow_empty_input,
	};
}
