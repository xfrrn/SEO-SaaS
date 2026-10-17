import * as z from "zod";

export const ticketId = z.string().trim().min(1).max(255);
export const ticketStatus = z.enum(["open", "in_progress", "closed"]);
const text = (limit: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(limit)
		.refine((value) => !value.includes("\0"));
const integer = z
	.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
	.pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));
export const pageQuery = z.object({
	limit: integer.pipe(z.number().min(1).max(100)).default(20),
	offset: integer.default(0),
});
export const listQuery = pageQuery.extend({ status: ticketStatus.optional() });
export const detailQuery = pageQuery.extend({ ticketId });
export const createBody = z.strictObject({
	title: text(200),
	content: text(10_000),
	idempotencyKey: z.uuid(),
});
export const replyBody = z.strictObject({
	ticketId,
	content: text(10_000),
	idempotencyKey: z.uuid(),
});
export const statusBody = z.strictObject({
	ticketId,
	status: ticketStatus,
	expectedRevision: z
		.number()
		.int()
		.min(0)
		.max(Number.MAX_SAFE_INTEGER - 1),
	idempotencyKey: z.uuid(),
});
