import { moderationError } from "./primitives";
import type { CommandState, ModerationRuntime, Prepared } from "./runtime";
import type {
	AttemptState,
	CheckRequest,
	EvaluationRequest,
	ModerationDecision,
	StoredRecord,
} from "./types";
import { checkWorkflow } from "./workflow";

export interface Reservation {
	command: StoredRecord<CommandState>;
	state: StoredRecord<AttemptState> | null;
	prior: ModerationDecision[];
	review_deadline: string | null;
}

export interface ReviewCommand {
	event_id: string;
	reason_code: string;
	expected_decision_id: string;
}

/** Reserve an execution before network work; the lease is also the execution deadline. */
export async function reserve<T extends object>(
	runtime: ModerationRuntime,
	prepared: Prepared,
	method: "check" | "evaluate",
	input: CheckRequest | EvaluationRequest,
	review?: ReviewCommand,
) {
	const hash = await runtime.fingerprint(
		input.context,
		review ? { input, review } : input,
	);
	return runtime.options.storage.transaction(
		input.context.tenant_id,
		async (tx): Promise<{ replay: T } | Reservation> => {
			const key = `${method}:${input.idempotency_key}`;
			const previous = await tx.get<CommandState>("command", key);
			if (previous) {
				if (
					previous.subject_id !== input.context.subject_id ||
					previous.data.fingerprint !== hash
				)
					throw moderationError(
						"IDEMPOTENCY_CONFLICT",
						"Moderation command key already used",
					);
				if (previous.data.status === "done" && previous.data.result)
					return { replay: previous.data.result as T };
				if (Date.parse(previous.data.lease_until) > Date.now())
					throw moderationError("IN_PROGRESS", "Moderation command is running");
			}
			await runtime.snapshots(tx, prepared);
			let state: StoredRecord<AttemptState> | null = null;
			let prior: ModerationDecision[] = [];
			let review_deadline: string | null = null;
			if ("attempt_kind" in input)
				({ state, prior, review_deadline } = await checkWorkflow(
					tx,
					input,
					review,
				));
			else if (input.attempt_id) {
				state = await runtime.attempt(tx, input.context, input.attempt_id);
				if (state.data.job_id !== input.job_id)
					throw moderationError("NOT_FOUND", "Moderation task not found");
			}
			const data: CommandState = {
				fingerprint: hash,
				status: "running",
				lease_until: new Date(
					Date.now() + prepared.policy.limits.command_lease_ms,
				).toISOString(),
				result: null,
			};
			const command = previous
				? await tx.replace(previous, data)
				: await tx.insert({
						kind: "command",
						key,
						subject_id: input.context.subject_id,
						attempt_id: input.attempt_id,
						data,
					});
			return { command, state, prior, review_deadline };
		},
	);
}

export async function abandon(
	runtime: ModerationRuntime,
	tenant_id: string,
	reservation: Reservation,
) {
	await runtime.options.storage.transaction(tenant_id, async (tx) => {
		const current = await tx.get<CommandState>(
			"command",
			reservation.command.key,
		);
		if (
			current?.revision === reservation.command.revision &&
			current.data.status === "running"
		)
			await tx.replace(current, {
				...current.data,
				lease_until: new Date(0).toISOString(),
			});
	});
}
