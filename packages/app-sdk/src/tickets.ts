import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth";
import {
	createAuthEndpoint,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import type { AdminOptions } from "better-auth/plugins/admin";
import { ticketSchema } from "./tickets/schema";
import { createTicketService } from "./tickets/service";
import {
	createBody,
	detailQuery,
	listQuery,
	replyBody,
	statusBody,
} from "./tickets/validation";

export type { SupportTicket, TicketEntry, TicketStatus } from "./tickets/types";

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		tickets: { creator: typeof tickets };
	}
}

/** Customer-owned feedback with administrator replies, status history and audit. */
export function tickets() {
	const authorize = (administrative: boolean) =>
		createAuthMiddleware(async (ctx) => {
			ctx.setHeader("Cache-Control", "no-store");
			const session = await getAuthoritativeSessionFromCtx(ctx);
			if (!session)
				throw new APIError("UNAUTHORIZED", { message: "请先登录。" });
			if ("banned" in session.user && session.user.banned)
				throw new APIError("FORBIDDEN", { message: "账号已停用。" });
			if ("impersonatedBy" in session.session && session.session.impersonatedBy)
				throw new APIError("FORBIDDEN", {
					message: "请结束模拟登录后操作工单。",
				});
			if (administrative) {
				const admin = ctx.context.getPlugin("admin") as {
					options: AdminOptions;
				} | null;
				if (!admin) throw new Error("Tickets requires the admin plugin");
				const roles =
					typeof admin.options.adminRoles === "string"
						? admin.options.adminRoles.split(",")
						: (admin.options.adminRoles ?? ["admin"]);
				const role =
					"role" in session.user && typeof session.user.role === "string"
						? session.user.role
						: "";
				if (
					!admin.options.adminUserIds?.includes(session.user.id) &&
					!role.split(",").some((value) => roles.includes(value))
				)
					throw new APIError("FORBIDDEN", { message: "没有工单管理权限。" });
			}
			return { ticketActor: { id: session.user.id, admin: administrative } };
		});
	const read = (admin: boolean) => ({
		method: "GET" as const,
		requireHeaders: true,
		use: [authorize(admin)],
		metadata: { noStore: true },
	});
	const write = (admin: boolean) => ({
		method: "POST" as const,
		requireHeaders: true,
		use: [authorize(admin)],
		metadata: { noStore: true },
	});
	return {
		id: "tickets",
		schema: ticketSchema,
		init(ctx) {
			if (
				!(ctx.getPlugin("admin") as { options: AdminOptions } | null)?.options
					.auditLog
			)
				throw new Error("Tickets requires admin({ auditLog: true })");
			if (
				ctx.adapter.id === "memory" ||
				!ctx.adapter.options?.adapterConfig.transaction
			)
				throw new Error(
					"Tickets requires a database adapter with real transactions and unique indexes",
				);
		},
		endpoints: {
			createSupportTicket: createAuthEndpoint(
				"/tickets/create",
				{ ...write(false), body: createBody },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).create(
							ctx.context.ticketActor.id,
							ctx.body,
						),
					),
			),
			listSupportTickets: createAuthEndpoint(
				"/tickets/list",
				{ ...read(false), query: listQuery },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).list(
							ctx.context.ticketActor,
							ctx.query,
						),
					),
			),
			getSupportTicket: createAuthEndpoint(
				"/tickets/get",
				{ ...read(false), query: detailQuery },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).get(
							ctx.context.ticketActor,
							ctx.query.ticketId,
							ctx.query.limit,
							ctx.query.offset,
						),
					),
			),
			replySupportTicket: createAuthEndpoint(
				"/tickets/reply",
				{ ...write(false), body: replyBody },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).write(
							ctx.context.ticketActor,
							{ ...ctx.body, kind: "reply" },
						),
					),
			),
			listAdminSupportTickets: createAuthEndpoint(
				"/tickets/admin/list",
				{ ...read(true), query: listQuery },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).list(
							ctx.context.ticketActor,
							ctx.query,
						),
					),
			),
			getAdminSupportTicket: createAuthEndpoint(
				"/tickets/admin/get",
				{ ...read(true), query: detailQuery },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).get(
							ctx.context.ticketActor,
							ctx.query.ticketId,
							ctx.query.limit,
							ctx.query.offset,
						),
					),
			),
			replyAdminSupportTicket: createAuthEndpoint(
				"/tickets/admin/reply",
				{ ...write(true), body: replyBody },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).write(
							ctx.context.ticketActor,
							{ ...ctx.body, kind: "reply" },
						),
					),
			),
			updateSupportTicketStatus: createAuthEndpoint(
				"/tickets/admin/status",
				{ ...write(true), body: statusBody },
				async (ctx) =>
					ctx.json(
						await createTicketService(ctx.context.adapter).write(
							ctx.context.ticketActor,
							{ ...ctx.body, kind: "status" },
						),
					),
			),
		},
	} satisfies BetterAuthPlugin;
}
