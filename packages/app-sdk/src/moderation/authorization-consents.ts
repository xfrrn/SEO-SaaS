import type { ConsentState } from "./consents";
import { bounded, canonical } from "./primitives";
import type { ModerationRuntime } from "./runtime";
import type {
	AttemptState,
	AuthorizeRequest,
	ModerationDecision,
	Operation,
	StoredRecord,
} from "./types";

export interface ConsentProof {
	attempt_revisions: Map<string, number>;
	revisions: Map<string, number>;
	reason: string | null;
}
interface SourceAttempt {
	record: StoredRecord<AttemptState>;
	operation: Operation;
}
type Asset = { item_id: string; revision: string; asset_ref: string };
const purpose = (operation: Operation) =>
	operation === "deliver" ? "publish" : operation;
const future = (value: string | null) =>
	value !== null &&
	Number.isFinite(Date.parse(value)) &&
	Date.parse(value) > Date.now();

/** Host checks run outside SQL; every observed revision is checked again before grant. */
export async function validateConsentScope(
	runtime: ModerationRuntime,
	input: AuthorizeRequest,
): Promise<ConsentProof> {
	const proof: ConsentProof = {
		attempt_revisions: new Map(),
		revisions: new Map(),
		reason: null,
	};
	const target = await runtime.options.storage.get<AttemptState>(
		input.context.tenant_id,
		"attempt",
		input.attempt_id,
	);
	if (
		!target ||
		target.subject_id !== input.context.subject_id ||
		target.data.subject_id !== input.context.subject_id
	)
		return proof;
	const attempts: SourceAttempt[] = [
		{ record: target, operation: input.operation },
	];
	const visited = new Set([target.key]);
	for (let index = 0; index < attempts.length; index++) {
		const attempt = attempts[index]!.record;
		proof.attempt_revisions.set(attempt.key, attempt.revision);
		if (attempt.data.revoked) return { ...proof, reason: "ATTEMPT_REVOKED" };
		for (const current of Object.values(attempt.data.stages)) {
			const decision = await runtime.options.storage.get<ModerationDecision>(
				input.context.tenant_id,
				"decision",
				current.decision_id,
			);
			if (!decision || decision.data.decision !== "allow")
				return { ...proof, reason: "CURRENT_DECISION_DENIED" };
		}
		for (const id of attempt.data.source_decision_ids) {
			const decision = await runtime.options.storage.get<ModerationDecision>(
				input.context.tenant_id,
				"decision",
				id,
			);
			const source = decision
				? await runtime.options.storage.get<AttemptState>(
						input.context.tenant_id,
						"attempt",
						decision.data.attempt_id,
					)
				: null;
			if (
				!source ||
				!decision ||
				source.subject_id !== source.data.subject_id ||
				decision.subject_id !== source.data.subject_id ||
				source.data.stages[decision.data.stage]?.decision_id !== id
			)
				return { ...proof, reason: "SOURCE_DECISION_INVALID" };
			if (visited.has(source.key)) continue;
			visited.add(source.key);
			attempts.push({
				record: source,
				operation:
					decision.data.stage === "output" ||
					decision.data.stage === "presentation"
						? "publish"
						: decision.data.operation,
			});
		}
	}
	const assets = new Map<string, Asset>();
	for (const { record } of attempts) {
		for (const asset of Object.values(record.data.stage_assets ?? {}).flat())
			assets.set(canonical([asset.asset_ref, asset.revision]), asset);
	}
	for (const { record: attempt, operation } of attempts) {
		for (const id of attempt.data.consent_ids) {
			const consent = await runtime.options.storage.get<ConsentState>(
				input.context.tenant_id,
				"consent",
				id,
			);
			if (
				!consent ||
				consent.subject_id !== attempt.data.subject_id ||
				consent.data.subject_id !== attempt.data.subject_id ||
				consent.data.status !== "verified" ||
				!consent.data.purposes.includes(purpose(operation)) ||
				!future(consent.data.expires_at) ||
				!future(consent.data.verified_expires_at) ||
				!consent.data.verified_purposes?.includes(purpose(operation)) ||
				!consent.data.purposes.includes(purpose(input.operation)) ||
				!consent.data.verified_purposes.includes(purpose(input.operation))
			)
				return { ...proof, reason: "CONSENT_INVALID" };
			const validate = runtime.options.validateConsent;
			if (!validate) return { ...proof, reason: "CONSENT_VALIDATOR_REQUIRED" };
			if (proof.revisions.has(id)) {
				if (proof.revisions.get(id) !== consent.revision)
					return { ...proof, reason: "CONSENT_RECHECK_REQUIRED" };
				continue;
			}
			try {
				await bounded(runtime.options.boundary_timeout_ms, () =>
					validate(
						input.context,
						consent.data,
						[...assets.values()],
						input.operation,
					),
				);
			} catch {
				return { ...proof, reason: "CONSENT_SCOPE_INVALID" };
			}
			proof.revisions.set(id, consent.revision);
		}
	}
	return proof;
}
