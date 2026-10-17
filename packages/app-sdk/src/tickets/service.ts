import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import { APIError } from "better-auth";
import { createAdminAuditService } from "better-auth/plugins/admin";
import type * as z from "zod";
import type { SupportTicket, TicketEntry } from "./types";
import type {
	createBody,
	listQuery,
	replyBody,
	statusBody,
} from "./validation";

type Actor = { id: string; admin: boolean };
type Write =
	| ({ kind: "reply" } & z.infer<typeof replyBody>)
	| ({ kind: "status" } & z.infer<typeof statusBody>);
const conflict = () =>
	new APIError("CONFLICT", {
		code: "TICKET_CONFLICT",
		message: "工单已更新或操作编号已被使用，请刷新后重试。",
	});

/** Use database transactions and revision checks for feedback, replies and audit. */
export function createTicketService(adapter: DBAdapter) {
	async function find(
		ticketId: string,
		actor: Actor,
		db: Pick<DBAdapter, "findOne"> = adapter,
	) {
		const ticket = await db.findOne<SupportTicket>({
			model: "supportTicket",
			where: [
				{ field: "id", value: ticketId },
				...(!actor.admin ? [{ field: "userId", value: actor.id }] : []),
			],
		});
		if (!ticket) throw new APIError("NOT_FOUND", { message: "工单不存在。" });
		return ticket;
	}
	const entryKey = (authorId: string, key: string) =>
		adapter.findOne<TicketEntry>({
			model: "supportTicketEntry",
			where: [
				{ field: "authorId", value: authorId },
				{ field: "idempotencyKey", value: key },
			],
		});
	function replay(entry: TicketEntry, input: Write, actor: Actor) {
		if (
			entry.ticketId !== input.ticketId ||
			entry.kind !== input.kind ||
			entry.authorRole !== (actor.admin ? "admin" : "user") ||
			(input.kind === "reply"
				? entry.content !== input.content
				: entry.status !== input.status ||
					entry.sequence - 1 !== input.expectedRevision)
		)
			throw conflict();
		return entry;
	}
	return {
		async list(actor: Actor, input: z.infer<typeof listQuery>) {
			const where: Where[] = [];
			if (!actor.admin) where.push({ field: "userId", value: actor.id });
			if (input.status) where.push({ field: "status", value: input.status });
			const [tickets, total] = await Promise.all([
				adapter.findMany<SupportTicket>({
					model: "supportTicket",
					where,
					limit: input.limit,
					offset: input.offset,
					sortBy: { field: "updatedAt", direction: "desc" },
				}),
				adapter.count({ model: "supportTicket", where }),
			]);
			return { tickets, total };
		},
		async get(actor: Actor, ticketId: string, limit: number, offset: number) {
			const ticket = await find(ticketId, actor);
			const where = [{ field: "ticketId", value: ticketId }];
			const [entries, total] = await Promise.all([
				adapter.findMany<TicketEntry>({
					model: "supportTicketEntry",
					where,
					limit,
					offset,
					sortBy: { field: "sequence", direction: "asc" },
				}),
				adapter.count({ model: "supportTicketEntry", where }),
			]);
			return { ticket, entries, total };
		},
		async create(userId: string, input: z.infer<typeof createBody>) {
			const existing = () =>
				adapter.findOne<SupportTicket>({
					model: "supportTicket",
					where: [
						{ field: "userId", value: userId },
						{ field: "idempotencyKey", value: input.idempotencyKey },
					],
				});
			function check(ticket: SupportTicket) {
				if (ticket.title !== input.title || ticket.content !== input.content)
					throw conflict();
				return { ticket };
			}
			const previous = await existing();
			if (previous) return check(previous);
			try {
				const now = new Date();
				return {
					ticket: await adapter.create<
						Omit<SupportTicket, "id">,
						SupportTicket
					>({
						model: "supportTicket",
						data: {
							...input,
							userId,
							status: "open",
							revision: 0,
							createdAt: now,
							updatedAt: now,
						},
					}),
				};
			} catch (error) {
				const committed = await existing();
				if (committed) return check(committed);
				throw error;
			}
		},
		async write(actor: Actor, input: Write) {
			await find(input.ticketId, actor);
			const previous = await entryKey(actor.id, input.idempotencyKey);
			if (previous) return { entry: replay(previous, input, actor) };
			try {
				return await adapter.transaction(async (db) => {
					const ticket = await find(input.ticketId, actor, db);
					if (
						input.kind === "status" &&
						(!actor.admin || ticket.revision !== input.expectedRevision)
					)
						throw conflict();
					if (input.kind === "reply" && ticket.status === "closed")
						throw new APIError("CONFLICT", {
							code: "TICKET_CLOSED",
							message: "工单已关闭，请联系管理员重新打开后再回复。",
						});
					const sequence = ticket.revision + 1;
					const now = new Date();
					const count = await db.updateMany({
						model: "supportTicket",
						where: [
							{ field: "id", value: ticket.id },
							{ field: "revision", value: ticket.revision },
						],
						update: {
							revision: sequence,
							updatedAt: now,
							...(input.kind === "status" ? { status: input.status } : {}),
						},
					});
					if (count !== 1) throw conflict();
					const entry = await db.create<Omit<TicketEntry, "id">, TicketEntry>({
						model: "supportTicketEntry",
						data: {
							ticketId: ticket.id,
							authorId: actor.id,
							authorRole: actor.admin ? "admin" : "user",
							kind: input.kind,
							content: input.kind === "reply" ? input.content : null,
							status: input.kind === "status" ? input.status : null,
							sequence,
							idempotencyKey: input.idempotencyKey,
							createdAt: now,
						},
					});
					if (actor.admin)
						await createAdminAuditService(db).record({
							operationId: `ticket:${entry.id}`,
							actorId: actor.id,
							targetId: ticket.id,
							action: `ticket.${input.kind}`,
							reason:
								input.kind === "reply"
									? "Reply to customer feedback"
									: "Update ticket status",
							status: "succeeded",
							details: {
								sequence,
								...(input.kind === "status" ? { status: input.status } : {}),
							},
						});
					return { entry };
				});
			} catch (error) {
				const committed = await entryKey(actor.id, input.idempotencyKey);
				if (committed) return { entry: replay(committed, input, actor) };
				throw error;
			}
		},
	};
}
