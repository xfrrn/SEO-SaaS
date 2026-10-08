import type { BetterAuthPlugin } from "@better-auth/core";
import {
	createAuthEndpoint,
	createAuthMiddleware,
} from "@better-auth/core/api";
import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";
import type { DBAdapter, Where } from "@better-auth/core/db/adapter";
import { APIError } from "@better-auth/core/error";
import * as z from "zod";
import { getAuthoritativeSessionFromCtx } from "../../api";
import { isAPIError } from "../../utils/is-api-error";
import { hasPermission } from "./has-permission";
import type { AdminOptions } from "./types";

/** JSON values suitable for nonsensitive audit metadata. Never include credentials. */
export type AdminAuditJSON =
	| string
	| number
	| boolean
	| null
	| AdminAuditJSON[]
	| { [key: string]: AdminAuditJSON };

/** One immutable lifecycle event for an administrator or trusted server operation. */
export interface AdminAuditInput {
	operationId: string;
	actorId: string;
	action: string;
	targetId: string;
	reason: string;
	status: "started" | "succeeded" | "failed";
	details?: AdminAuditJSON;
}

/** Append-only event. A lone started event means the outcome is unconfirmed. */
export interface AdminAuditLog extends AdminAuditInput {
	id: string;
	createdAt: Date;
}

type AuditRow = Omit<AdminAuditLog, "details"> & { details?: string | null };

/** Optional table; no user foreign keys so deleting an account preserves its history. */
export const adminAuditSchema = {
	adminAuditLog: {
		fields: {
			operationId: { type: "string", required: true },
			actorId: { type: "string", required: true },
			action: { type: "string", required: true },
			targetId: { type: "string", required: true },
			reason: { type: "string", required: true },
			status: { type: "string", required: true },
			details: { type: "string", required: false },
			createdAt: { type: "date", required: true },
		},
		indexes: [{ fields: ["operationId", "status"], unique: true }],
	},
} satisfies BetterAuthPluginDBSchema;

const identifier = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => value === value.trim());
const auditInput = z.object({
	operationId: identifier.max(255),
	actorId: identifier,
	action: identifier,
	targetId: identifier,
	reason: z.string().trim().min(1).max(500),
	status: z.enum(["started", "succeeded", "failed"]),
});
const queryInteger = z.union([
	z.number(),
	z.string().regex(/^\d+$/).transform(Number),
]);
const auditQuery = z.object({
	limit: queryInteger.pipe(z.number().int().min(1).max(100)).default(20),
	offset: queryInteger
		.pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
		.default(0),
	actorId: identifier.optional(),
	targetId: identifier.optional(),
});

function serializeDetails(value: AdminAuditJSON): string {
	const ancestors = new Set<object>();
	function normalize(item: unknown, depth: number): AdminAuditJSON {
		if (depth > 8) throw new Error("Audit details exceed the nesting limit");
		if (item === null || typeof item === "string" || typeof item === "boolean")
			return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object" || !item || ancestors.has(item))
			throw new Error("Audit details must be JSON-safe");
		ancestors.add(item);
		let result: AdminAuditJSON;
		if (Array.isArray(item)) {
			result = item.map((entry) => normalize(entry, depth + 1));
		} else {
			if (
				Object.getPrototypeOf(item) !== Object.prototype &&
				Object.getPrototypeOf(item) !== null
			)
				throw new Error("Audit details must contain plain JSON objects");
			result = Object.fromEntries(
				Object.entries(item)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, entry]) => {
						if (
							/(password|secret|token|authorization|cookie|credential|(?:private|api|access).?key)/i.test(
								key,
							)
						)
							throw new Error(
								"Credentials must not be included in audit details",
							);
						return [key, normalize(entry, depth + 1)];
					}),
			);
		}
		ancestors.delete(item);
		return result;
	}
	const serialized = JSON.stringify(normalize(value, 0));
	if (serialized.length > 8192)
		throw new Error("Audit details exceed 8192 characters");
	return serialized;
}

function publicEntry(row: AuditRow): AdminAuditLog {
	const { details, ...entry } = row;
	return {
		...entry,
		...(details === null || details === undefined
			? {}
			: { details: JSON.parse(details) as AdminAuditJSON }),
	};
}

/**
 * Append and read audit events using only the supplied adapter, including transaction adapters.
 * Enable admin({ auditLog: true }) and migrate its unique index first. Call only from trusted
 * server code; authenticate/authorize callers separately. Never store credentials in any field.
 * There is deliberately no update/delete method. This is not a database tamper-proofing layer.
 */
export function createAdminAuditService(
	adapter: Pick<DBAdapter, "id" | "create" | "findOne" | "findMany" | "count">,
) {
	if (adapter.id === "memory")
		throw new Error("Admin auditing requires database-enforced unique indexes");
	return {
		async record(
			input: AdminAuditInput,
		): Promise<{ entry: AdminAuditLog; applied: boolean }> {
			const data = {
				...auditInput.parse(input),
				details:
					input.details === undefined ? null : serializeDetails(input.details),
			};
			const findExisting = () =>
				adapter.findOne<AuditRow>({
					model: "adminAuditLog",
					where: [
						{ field: "operationId", value: data.operationId },
						{ field: "status", value: data.status },
					],
				});
			function replay(entry: AuditRow) {
				if (
					entry.actorId !== data.actorId ||
					entry.action !== data.action ||
					entry.targetId !== data.targetId ||
					entry.reason !== data.reason ||
					(entry.details ?? null) !== data.details
				) {
					throw new APIError("CONFLICT", {
						code: "ADMIN_AUDIT_CONFLICT",
						message:
							"The audit operation and status already have a different payload",
					});
				}
				return { entry: publicEntry(entry), applied: false };
			}
			const existing = await findExisting();
			if (existing) return replay(existing);
			try {
				const entry = await adapter.create<Omit<AuditRow, "id">, AuditRow>({
					model: "adminAuditLog",
					data: { ...data, createdAt: new Date() },
				});
				return { entry: publicEntry(entry), applied: true };
			} catch (error) {
				const committed = await findExisting();
				if (committed) return replay(committed);
				throw error;
			}
		},
		async list(input: {
			limit: number;
			offset: number;
			actorId?: string;
			targetId?: string;
		}) {
			const query = auditQuery.parse(input);
			const where: Where[] = [];
			if (query.actorId) where.push({ field: "actorId", value: query.actorId });
			if (query.targetId)
				where.push({ field: "targetId", value: query.targetId });
			const entries = await adapter.findMany<AuditRow>({
				model: "adminAuditLog",
				where,
				limit: query.limit,
				offset: query.offset,
				sortBy: { field: "createdAt", direction: "desc" },
			});
			const total = await adapter.count({ model: "adminAuditLog", where });
			return {
				entries: entries.map(publicEntry),
				total,
				limit: query.limit,
				offset: query.offset,
			};
		},
	};
}

export const listAuditLogs = (options: AdminOptions) =>
	createAuthEndpoint(
		"/admin/audit-logs",
		{ method: "GET", requireHeaders: true, query: auditQuery.optional() },
		async (ctx) => {
			const session = await getAuthoritativeSessionFromCtx<{ role?: string }>(
				ctx,
			);
			if (!session) throw new APIError("UNAUTHORIZED");
			if (
				!hasPermission({
					userId: session.user.id,
					role: session.user.role,
					options,
					permissions: { audit: ["list"] },
				})
			)
				throw new APIError("FORBIDDEN");
			return ctx.json(
				await createAdminAuditService(ctx.context.adapter).list(
					ctx.query ?? { limit: 20, offset: 0 },
				),
			);
		},
	);

const auditedActions = new Set(
	[
		"set-role",
		"create-user",
		"update-user",
		"ban-user",
		"unban-user",
		"impersonate-user",
		"stop-impersonating",
		"revoke-user-session",
		"revoke-user-sessions",
		"remove-user",
		"set-user-password",
	].map((action) => `/admin/${action}`),
);

/** Record request outcomes; interruptions remain started for subsequent reconciliation. */
export function createAdminAuditHooks(): NonNullable<
	BetterAuthPlugin["hooks"]
> {
	return {
		before: [
			{
				matcher: (ctx) => auditedActions.has(ctx.path ?? ""),
				handler: createAuthMiddleware(async (ctx) => {
					const session = await getAuthoritativeSessionFromCtx<
						{ role?: string },
						{ impersonatedBy?: string }
					>(ctx);
					// Trusted server-only createUser calls have no authenticated actor to attribute.
					if (!session) return;
					const body: Record<string, unknown> = ctx.body ?? {};
					let targetId =
						typeof body.userId === "string" || typeof body.userId === "number"
							? String(body.userId)
							: "new-user";
					if (ctx.path === "/admin/revoke-user-session") {
						const target =
							typeof body.sessionToken === "string"
								? await ctx.context.internalAdapter.findSession(
										body.sessionToken,
									)
								: null;
						targetId = target?.session.id ?? "unknown-session";
					}
					if (ctx.path === "/admin/stop-impersonating")
						targetId = session.user.id;
					const event: AdminAuditInput = {
						operationId: crypto.randomUUID(),
						actorId: session.session.impersonatedBy ?? session.user.id,
						action: `admin.${ctx.path?.slice("/admin/".length)}`,
						targetId,
						reason: "Admin API request",
						status: "started",
					};
					await createAdminAuditService(ctx.context.adapter).record(event);
					return { context: { context: { adminAuditEvent: event } } };
				}),
			},
		],
		after: [
			{
				matcher: (ctx) => auditedActions.has(ctx.path ?? ""),
				handler: createAuthMiddleware(async (ctx) => {
					const event = (ctx.context as { adminAuditEvent?: AdminAuditInput })
						.adminAuditEvent;
					if (!event) return;
					const returned: unknown = ctx.context.returned;
					const failed = isAPIError(returned);
					const result =
						returned && typeof returned === "object" && "user" in returned
							? returned.user
							: undefined;
					const createdUserId =
						ctx.path === "/admin/create-user" &&
						result &&
						typeof result === "object" &&
						"id" in result &&
						typeof result.id === "string"
							? result.id
							: undefined;
					await createAdminAuditService(ctx.context.adapter).record({
						...event,
						status: failed ? "failed" : "succeeded",
						targetId: createdUserId ?? event.targetId,
					});
				}),
			},
		],
	};
}
