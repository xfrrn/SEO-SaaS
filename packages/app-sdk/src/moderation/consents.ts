import * as z from "zod";
import {
	contentDigest,
	nullableToken,
	timestamp,
	token,
	trustedContext,
} from "./lifecycle-validation";
import { moderationError } from "./primitives";
import type { ModerationRuntime } from "./runtime";
import type { AttemptState, ConsentDeclaration, StoredRecord } from "./types";

const purposes = z
	.array(token)
	.min(1)
	.max(100)
	.refine((values) => new Set(values).size === values.length);
const recordSchema = z
	.object({
		context: trustedContext,
		event_id: token,
		asset_digest: contentDigest,
		declaration_version: token,
		purposes,
		expires_at: timestamp,
		evidence_ref: nullableToken,
	})
	.strict();
const verifySchema = z
	.object({
		context: trustedContext,
		event_id: token,
		consent_id: token,
		expected_consent_revision: z.number().int().positive(),
		evidence_ref: nullableToken,
		method: token,
		status: z.enum(["verified", "rejected", "insufficient"]),
		purposes,
		expires_at: timestamp,
		reason_code: token,
	})
	.strict();
const revokeSchema = z
	.object({
		context: trustedContext,
		event_id: token,
		consent_id: token,
		expected_consent_revision: z.number().int().positive(),
		reason_code: token,
	})
	.strict();

export type ConsentRequest = z.infer<typeof recordSchema>;
export type VerifyConsentRequest = z.infer<typeof verifySchema>;
export type RevokeConsentRequest = z.infer<typeof revokeSchema>;
export interface ConsentState extends ConsentDeclaration {
	verified_purposes: string[] | null;
	verified_expires_at: string | null;
	verification_method: string | null;
	verification_evidence_ref: string | null;
}

export function createModerationConsents(runtime: ModerationRuntime) {
	async function recordConsent(request: ConsentRequest) {
		const input = recordSchema.parse(request);
		return runtime.command(
			input.context,
			"consent_declaration",
			input.event_id,
			input,
			"consent",
			async (tx) => {
				if (Date.parse(input.expires_at) <= Date.now())
					throw moderationError(
						"INVALID_CONSENT",
						"Consent must expire in the future",
					);
				const consent_id = crypto.randomUUID();
				const declaration: ConsentState = {
					consent_id,
					subject_id: input.context.subject_id,
					actor_id: input.context.actor_id,
					asset_digest: input.asset_digest,
					declaration_version: input.declaration_version,
					purposes: input.purposes,
					expires_at: input.expires_at,
					evidence_ref: input.evidence_ref,
					status: "declared",
					revision: 1,
					created_at: new Date().toISOString(),
					verified_purposes: null,
					verified_expires_at: null,
					verification_method: null,
					verification_evidence_ref: null,
				};
				await tx.insert({
					kind: "consent",
					key: consent_id,
					subject_id: input.context.subject_id,
					attempt_id: null,
					data: declaration,
				});
				await runtime.event(
					tx,
					input.context,
					`consent_declaration:${input.event_id}`,
					"consent_declaration",
					{
						consent_id,
						asset_digest: input.asset_digest,
						declaration_version: input.declaration_version,
						purposes: input.purposes,
						expires_at: input.expires_at,
						evidence_ref: input.evidence_ref,
					},
				);
				return declaration;
			},
		);
	}

	async function verifyConsent(request: VerifyConsentRequest) {
		const input = verifySchema.parse(request);
		return runtime.command(
			input.context,
			"consent_verification",
			input.event_id,
			input,
			"verify_consent",
			async (tx, prepared) => {
				const record = await tx.get<ConsentState>("consent", input.consent_id);
				validateRevision(
					record,
					input.context.subject_id,
					input.expected_consent_revision,
				);
				if (record.data.status === "revoked")
					throw moderationError(
						"INVALID_CONSENT",
						"Revoked consent cannot be verified",
					);
				if (
					input.purposes.some(
						(purpose) => !record.data.purposes.includes(purpose),
					) ||
					Date.parse(input.expires_at) > Date.parse(record.data.expires_at) ||
					(input.status === "verified" &&
						Date.parse(input.expires_at) <= Date.now())
				)
					throw moderationError(
						"INVALID_CONSENT",
						"Verification cannot expand the declaration scope or lifetime",
					);
				if (input.status === "verified" && input.evidence_ref === null)
					throw moderationError(
						"INVALID_CONSENT",
						"Verified consent requires a private evidence reference",
					);
				await runtime.event(
					tx,
					input.context,
					`consent_verification:${input.event_id}`,
					"consent_verification",
					{
						consent_id: input.consent_id,
						previous_revision: record.data.revision,
						status: input.status,
						method: input.method,
						purposes: input.purposes,
						expires_at: input.expires_at,
						evidence_ref: input.evidence_ref,
						reason_code: input.reason_code,
					},
				);
				const updated: ConsentState = {
					...record.data,
					status: input.status,
					revision: record.data.revision + 1,
					verified_purposes: input.purposes,
					verified_expires_at: input.expires_at,
					verification_method: input.method,
					verification_evidence_ref: input.evidence_ref,
				};
				await tx.replace(record, updated);
				await withdrawRelated(
					tx,
					input.context.subject_id,
					input.consent_id,
					prepared.policy.limits.max_page_size,
				);
				return updated;
			},
		);
	}

	async function revokeConsent(request: RevokeConsentRequest) {
		const input = revokeSchema.parse(request);
		return runtime.command(
			input.context,
			"consent_revocation",
			input.event_id,
			input,
			"consent",
			async (tx, prepared) => {
				const record = await tx.get<ConsentState>("consent", input.consent_id);
				validateRevision(
					record,
					input.context.subject_id,
					input.expected_consent_revision,
				);
				await runtime.event(
					tx,
					input.context,
					`consent_revocation:${input.event_id}`,
					"consent_revocation",
					{
						consent_id: input.consent_id,
						previous_revision: record.data.revision,
						reason_code: input.reason_code,
					},
				);
				const updated: ConsentState = {
					...record.data,
					status: "revoked",
					revision: record.data.revision + 1,
				};
				await tx.replace(record, updated);
				await withdrawRelated(
					tx,
					input.context.subject_id,
					input.consent_id,
					prepared.policy.limits.max_page_size,
				);
				return updated;
			},
		);
	}
	return { recordConsent, verifyConsent, revokeConsent };
}

function validateRevision(
	record: StoredRecord<ConsentState> | null,
	subject_id: string,
	revision: number,
): asserts record is StoredRecord<ConsentState> {
	if (!record || record.data.subject_id !== subject_id)
		throw moderationError("NOT_FOUND", "Consent declaration not found");
	if (record.data.revision !== revision)
		throw moderationError("STATE_CONFLICT", "Consent declaration changed", {
			current_consent_revision: record.data.revision,
		});
}

async function withdrawRelated(
	tx: Parameters<ModerationRuntime["attempt"]>[0],
	subject_id: string,
	consent_id: string,
	limit: number,
) {
	let after: string | undefined;
	for (;;) {
		const records = await tx.list<AttemptState>("attempt", {
			subject_id,
			...(after ? { after } : {}),
			limit,
		});
		for (const record of records) {
			if (record.data.consent_ids.includes(consent_id))
				await tx.replace(record, {
					...record.data,
					revoked: true,
					revocation_reasons: [
						...new Set([
							...(record.data.revocation_reasons ?? []),
							"consent_changed",
						]),
					],
					delivery_epoch: record.data.delivery_epoch + 1,
				});
		}
		if (records.length < limit) break;
		after = records[records.length - 1]!.key;
	}
}
