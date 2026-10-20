import * as z from "zod";
import { moderationError } from "./primitives";
import type {
	ModerationDecision,
	ModerationTransaction,
	TrustedContext,
} from "./types";
import { contextSchema, identifier } from "./validation";

export const token = identifier;
export const timestamp = z
	.string()
	.datetime({ offset: true })
	.transform((value) => new Date(value).toISOString());
export const trustedContext = contextSchema;
export const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const nullableToken = token.nullable();
export const pageLimit = z.number().int().positive();

export function boundedLimit(limit: number | undefined, maximum: number) {
	if (limit !== undefined && limit > maximum)
		throw moderationError("LIMIT_EXCEEDED", "Moderation page limit exceeded");
	return limit ?? maximum;
}

export async function decisionForAttempt(
	tx: ModerationTransaction,
	context: TrustedContext,
	decision_id: string,
	attempt_id?: string,
) {
	const record = await tx.get<ModerationDecision>("decision", decision_id);
	if (
		!record ||
		record.data.subject_id !== context.subject_id ||
		(attempt_id && record.data.attempt_id !== attempt_id)
	) {
		throw moderationError("NOT_FOUND", "Moderation decision not found");
	}
	return record;
}
