import * as z from "zod";
import {
	boundedLimit,
	pageLimit,
	timestamp,
	token,
	trustedContext,
} from "./lifecycle-validation";
import { bounded, canonical, digest, moderationError } from "./primitives";
import type { ModerationRuntime } from "./runtime";
import type {
	AttemptState,
	ModerationDecision,
	ModerationTransaction,
	RecordKind,
	StoredRecord,
} from "./types";

const pageSchema = z
	.object({
		context: trustedContext,
		cursor: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[A-Za-z0-9_.:-]+$/)
			.optional(),
		limit: pageLimit.optional(),
	})
	.strict();
const cleanupSchema = pageSchema
	.extend({
		cleanup_id: token,
		idempotency_key: token,
		subject_id: token.optional(),
		before: timestamp.optional(),
	})
	.refine(
		(input) => input.subject_id !== undefined || input.before !== undefined,
		"A deletion subject or retention cutoff is required",
	);

export type CleanupRequest = z.infer<typeof cleanupSchema>;
interface CleanupScope {
	fingerprint: string;
	cursor: string | null;
	active_batch: string | null;
	cutoff: string;
}
interface CleanupCandidate {
	kind: RecordKind;
	key: string;
	refs: string[];
	attempt_id: string | null;
	subject_id: string | null;
}
export interface CleanupReceipt {
	cleanup_id: string;
	status: "completed" | "partial" | "failed";
	next_cursor: string | null;
	removed: number;
	failed: number;
	restricted_exceptions: number;
}
interface CleanupBatch {
	candidates: CleanupCandidate[];
	next_cursor: string | null;
	restricted_exceptions: number;
	receipt: CleanupReceipt | null;
	fingerprint: string;
}
const cleanupKinds: RecordKind[] = [
	"consent",
	"attempt",
	"report",
	"decision",
	"event",
	"command",
	"action",
	"counter",
];

export function createModerationCleanup(runtime: ModerationRuntime) {
	async function cleanupData(request: CleanupRequest) {
		const input = cleanupSchema.parse(request);
		const batchKey = await digest([input.cleanup_id, input.idempotency_key]);
		const prepared = await runtime.prepare(input.context, "cleanup");
		if (input.subject_id && input.subject_id !== input.context.subject_id) {
			const authorized = await bounded(
				runtime.options.boundary_timeout_ms,
				() =>
					runtime.options.authorize(
						{ ...input.context, subject_id: input.subject_id! },
						"cleanup",
					),
			);
			if (authorized === false)
				throw moderationError(
					"FORBIDDEN",
					"Moderation authorization was denied",
				);
		}
		const limit = boundedLimit(
			input.limit,
			prepared.policy.limits.max_page_size,
		);
		if (
			input.before &&
			Date.parse(input.before) >
				Date.now() - prepared.policy.limits.retention_ms
		)
			throw moderationError(
				"INVALID_RETENTION",
				"Retention cleanup cutoff is too recent",
			);
		const scope = {
			subject_id: input.subject_id ?? null,
			before: input.before ?? null,
		};
		const plan = await runtime.options.storage.transaction(
			input.context.tenant_id,
			async (tx) => {
				await runtime.snapshots(tx, prepared);
				const previous = await tx.get<CleanupScope>(
					"cleanup",
					`scope:${input.cleanup_id}`,
				);
				const fingerprint = await runtime.fingerprint(input.context, scope);
				if (previous && previous.data.fingerprint !== fingerprint)
					throw moderationError(
						"IDEMPOTENCY_CONFLICT",
						"Cleanup scope cannot change",
					);
				const scopeRecord =
					previous ??
					(await tx.insert({
						kind: "cleanup",
						key: `scope:${input.cleanup_id}`,
						subject_id: null,
						attempt_id: null,
						data: {
							fingerprint,
							cursor: null,
							active_batch: null,
							cutoff: new Date(Date.now() + 1).toISOString(),
						} satisfies CleanupScope,
					}));
				const inputFingerprint = await runtime.fingerprint(
					input.context,
					input,
				);
				const existingBatch = await tx.get<CleanupBatch>(
					"cleanup",
					`batch:${batchKey}`,
				);
				if (existingBatch) {
					if (existingBatch.data.fingerprint !== inputFingerprint)
						throw moderationError(
							"IDEMPOTENCY_CONFLICT",
							"Cleanup batch key already used",
						);
					return existingBatch.data;
				}
				if (scopeRecord.data.active_batch !== null)
					throw moderationError(
						"IN_PROGRESS",
						"Resume the active cleanup batch before starting another",
					);
				if ((input.cursor ?? null) !== scopeRecord.data.cursor)
					throw moderationError(
						"STATE_CONFLICT",
						"Cleanup cursor does not match the previous receipt",
					);
				const batch = {
					...(await planCleanup(
						tx,
						{ ...input, before: input.before ?? scopeRecord.data.cutoff },
						limit,
					)),
					fingerprint: inputFingerprint,
				};
				await tx.replace(scopeRecord, {
					...scopeRecord.data,
					active_batch: batchKey,
				});
				await tx.insert({
					kind: "cleanup",
					key: `batch:${batchKey}`,
					subject_id: null,
					attempt_id: null,
					data: batch,
				});
				return batch;
			},
		);
		const existing = await runtime.options.storage.get<CleanupBatch>(
			input.context.tenant_id,
			"cleanup",
			`batch:${batchKey}`,
		);
		if (existing?.data.receipt) return existing.data.receipt;
		const erased: CleanupCandidate[] = [];
		let failed = 0;
		for (const candidate of plan.candidates) {
			try {
				for (const resource_ref of candidate.refs) {
					if (!runtime.options.erase)
						throw moderationError(
							"ERASE_ADAPTER_MISSING",
							"Private resource deletion requires a host adapter",
						);
					const erasedResource = await bounded(
						runtime.options.boundary_timeout_ms,
						(signal) =>
							runtime.options.erase!({
								context: {
									...input.context,
									subject_id: candidate.subject_id ?? input.context.subject_id,
								},
								cleanup_id: input.cleanup_id,
								resource_ref,
								signal,
							}),
					);
					if (erasedResource === false)
						throw new Error("Moderation erase was denied");
				}
				erased.push(candidate);
			} catch {
				failed++;
			}
		}
		return runtime.options.storage.transaction(
			input.context.tenant_id,
			async (tx) => {
				const batch = await tx.get<CleanupBatch>(
					"cleanup",
					`batch:${batchKey}`,
				);
				if (!batch)
					throw moderationError("STATE_CONFLICT", "Cleanup batch disappeared");
				if (batch.data.receipt) return batch.data.receipt;
				let removed = 0;
				for (const candidate of erased) {
					const record = await tx.get<Record<string, unknown>>(
						candidate.kind,
						candidate.key,
					);
					// Re-check after the external erase window: a record that became
					// restricted (legal hold) must survive this deletion batch.
					if (record && (await isRestrictedRecord(tx, record))) continue;
					await tx.remove(candidate.kind, candidate.key);
					removed++;
				}
				const receipt: CleanupReceipt = {
					cleanup_id: input.cleanup_id,
					status: failed
						? removed
							? "partial"
							: "failed"
						: plan.next_cursor || plan.restricted_exceptions
							? "partial"
							: "completed",
					next_cursor: failed ? (input.cursor ?? null) : plan.next_cursor,
					removed,
					failed,
					restricted_exceptions: plan.restricted_exceptions,
				};
				await tx.replace(batch, { ...batch.data, candidates: [], receipt });
				const scopeRecord = await tx.get<CleanupScope>(
					"cleanup",
					`scope:${input.cleanup_id}`,
				);
				if (!scopeRecord || scopeRecord.data.active_batch !== batchKey)
					throw moderationError(
						"STATE_CONFLICT",
						"Cleanup batch no longer owns its scope",
					);
				await tx.replace(scopeRecord, {
					...scopeRecord.data,
					active_batch: null,
					cursor: receipt.next_cursor,
				});
				await tx.insert({
					kind: "event",
					key: `cleanup_receipt:${batchKey}`,
					subject_id: null,
					attempt_id: null,
					data: {
						type: "cleanup_receipt",
						occurred_at: new Date().toISOString(),
						status: receipt.status,
						removed: receipt.removed,
						failed,
						restricted_exceptions: receipt.restricted_exceptions,
					},
				});
				return receipt;
			},
		);
	}
	return { cleanupData };
}

async function planCleanup(
	tx: Parameters<ModerationRuntime["attempt"]>[0],
	input: CleanupRequest,
	limit: number,
): Promise<Omit<CleanupBatch, "fingerprint">> {
	const candidates: CleanupCandidate[] = [];
	let restricted_exceptions = 0;
	let next_cursor: string | null = null;
	const cursor = input.cursor
		? (JSON.parse(
				new TextDecoder().decode(
					Uint8Array.from(
						atob(input.cursor.replaceAll("-", "+").replaceAll("_", "/")),
						(char) => char.charCodeAt(0),
					),
				),
			) as unknown)
		: null;
	const parsed = z
		.tuple([
			z
				.number()
				.int()
				.min(0)
				.max(cleanupKinds.length - 1),
			z.string(),
		])
		.nullable()
		.parse(cursor);
	for (let index = parsed?.[0] ?? 0; index < cleanupKinds.length; index++) {
		const kind = cleanupKinds[index]!;
		const records = await tx.list<Record<string, unknown>>(kind, {
			...(input.subject_id ? { subject_id: input.subject_id } : {}),
			...(input.before ? { before: new Date(input.before).toISOString() } : {}),
			...(parsed && index === parsed[0] && parsed[1]
				? { after: parsed[1] }
				: {}),
			limit: limit - candidates.length,
		});
		for (const record of records) {
			if (
				record.key.startsWith("cleanup_") ||
				(record.kind === "command" && record.key.startsWith("cleanup_batch:"))
			)
				continue;
			const attempt = record.attempt_id
				? await tx.get<AttemptState>("attempt", record.attempt_id)
				: null;
			if (await isRestrictedRecord(tx, record)) {
				restricted_exceptions++;
				continue;
			}
			if (record.kind === "consent" && record.data.status !== "revoked") {
				if (
					typeof record.data.revision !== "number" ||
					!Number.isSafeInteger(record.data.revision)
				)
					throw moderationError(
						"INVALID_STORED_DATA",
						"Consent revision is invalid",
					);
				await tx.replace(record, {
					...record.data,
					status: "revoked",
					revision: record.data.revision + 1,
				});
			}
			if (
				attempt &&
				!(attempt.data.revocation_reasons ?? []).includes("cleanup")
			)
				await tx.replace(attempt, {
					...attempt.data,
					revoked: true,
					revocation_reasons: [
						...new Set([...(attempt.data.revocation_reasons ?? []), "cleanup"]),
					],
					delivery_epoch: attempt.data.delivery_epoch + 1,
				});
			candidates.push({
				kind,
				key: record.key,
				refs: privateReferences(record.data),
				attempt_id: record.attempt_id,
				subject_id: record.subject_id,
			});
		}
		if (candidates.length === limit || records.length === limit) {
			next_cursor = btoa(
				canonical([index, records[records.length - 1]?.key ?? ""]),
			)
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replaceAll("=", "");
			break;
		}
	}
	return { candidates, next_cursor, restricted_exceptions, receipt: null };
}

function privateReferences(value: unknown): string[] {
	const refs = new Set<string>();
	function walk(entry: unknown) {
		if (!entry || typeof entry !== "object") return;
		for (const [key, item] of Object.entries(entry)) {
			if (
				[
					"evidence_ref",
					"verification_evidence_ref",
					"asset_ref",
					"transcript_ref",
				].includes(key) &&
				typeof item === "string"
			)
				refs.add(item);
			else if (typeof item === "object") walk(item);
		}
	}
	walk(value);
	return [...refs];
}

function hasRestrictedProjection(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const object = value as Record<string, unknown>;
	if (
		object.decision === "legal_hold" ||
		object.type === "restricted_handoff" ||
		object.type === "restricted_consent" ||
		object.type === "legal_hold"
	)
		return true;
	return Object.values(object).some(hasRestrictedProjection);
}

/**
 * A record is retained (excluded from ordinary cleanup) when its projection is
 * restricted or when it belongs to an attempt currently under legal hold. This
 * must be re-checked inside the final deletion transaction: a review or
 * restricted-signal evaluation can record `legal_hold` after the cleanup plan was
 * created but before the records are removed.
 */
async function isRestrictedRecord(
	tx: ModerationTransaction,
	record: StoredRecord<Record<string, unknown>>,
): Promise<boolean> {
	if (hasRestrictedProjection(record.data)) return true;
	if (
		record.kind === "consent" &&
		(await tx.get("event", `restricted_consent:${record.key}`))
	)
		return true;
	if (!record.attempt_id) return false;
	const attempt = await tx.get<AttemptState>("attempt", record.attempt_id);
	if (!attempt) return false;
	for (const reference of Object.values(attempt.data.stages)) {
		if (
			reference &&
			(await tx.get<ModerationDecision>("decision", reference.decision_id))
				?.data.decision === "legal_hold"
		)
			return true;
	}
	return false;
}
