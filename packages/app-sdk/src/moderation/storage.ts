import type { BetterAuthOptions } from "better-auth";
import type {
	DBAdapter,
	DBTransactionAdapter,
	Where,
} from "better-auth/adapters";
import { canonical, moderationError } from "./primitives";
import type {
	ModerationStorage,
	ModerationTransaction,
	RecordInput,
	RecordKind,
	RecordQuery,
	StoredRecord,
} from "./types";

const kinds = new Set<RecordKind>([
	"policy",
	"capability",
	"attempt",
	"report",
	"decision",
	"event",
	"command",
	"action",
	"consent",
	"counter",
	"cleanup",
]);
const mutable = new Set<RecordKind>([
	"attempt",
	"command",
	"action",
	"consent",
	"counter",
	"cleanup",
]);
type Row = {
	id: string;
	tenantId: string;
	kind: RecordKind;
	recordKey: string;
	subjectId?: string | null;
	attemptId?: string | null;
	payload: string;
	revision: number;
	createdAt: Date | string;
};

function identifier(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0)
		throw moderationError(
			"INVALID_DATA",
			"Moderation identifiers must be nonempty strings",
		);
}
function recordKind(kind: RecordKind) {
	if (!kinds.has(kind))
		throw moderationError("INVALID_DATA", "Unknown moderation record kind");
}
function isoDate(value: string) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
		throw moderationError(
			"INVALID_DATA",
			"Moderation timestamps must use UTC ISO 8601",
		);
	return date;
}
function payload(data: object): string {
	if (!data || Object.getPrototypeOf(data) !== Object.prototype)
		throw moderationError(
			"INVALID_DATA",
			"Moderation record data must be a JSON object",
		);
	return canonical(data);
}
function decode<T extends object>(row: Row): StoredRecord<T> {
	try {
		identifier(row.id);
		identifier(row.tenantId);
		identifier(row.recordKey);
		recordKind(row.kind);
		if (
			typeof row.payload !== "string" ||
			!Number.isSafeInteger(row.revision) ||
			row.revision < 0 ||
			(row.subjectId != null && typeof row.subjectId !== "string") ||
			(row.attemptId != null && typeof row.attemptId !== "string")
		)
			throw new Error("Invalid stored record");
		const data: unknown = JSON.parse(row.payload);
		if (!data || typeof data !== "object" || Array.isArray(data))
			throw new Error("Invalid stored payload");
		payload(data);
		const created_at =
			row.createdAt instanceof Date
				? row.createdAt.toISOString()
				: isoDate(row.createdAt).toISOString();
		return {
			id: row.id,
			tenant_id: row.tenantId,
			kind: row.kind,
			key: row.recordKey,
			subject_id: row.subjectId ?? null,
			attempt_id: row.attemptId ?? null,
			data: data as T,
			revision: row.revision,
			created_at,
		};
	} catch {
		throw moderationError(
			"INVALID_STORED_DATA",
			"Moderation storage contains an invalid record",
		);
	}
}
function selector(tenant_id: string, kind: RecordKind, key?: string): Where[] {
	identifier(tenant_id);
	recordKind(kind);
	if (key !== undefined) identifier(key);
	return [
		{ field: "tenantId", value: tenant_id },
		{ field: "kind", value: kind },
		...(key === undefined ? [] : [{ field: "recordKey", value: key }]),
	];
}
function scoped<Options extends BetterAuthOptions>(
	db: DBTransactionAdapter<Options>,
	tenant_id: string,
): ModerationTransaction {
	async function get<T extends object>(kind: RecordKind, key: string) {
		const row = await db.findOne<Row>({
			model: "moderationRecord",
			where: selector(tenant_id, kind, key),
		});
		return row ? decode<T>(row) : null;
	}
	return {
		get,
		async list<T extends object>(kind: RecordKind, query: RecordQuery) {
			const where = selector(tenant_id, kind);
			if (
				!Number.isSafeInteger(query.limit) ||
				query.limit < 1 ||
				query.limit > 1000
			)
				throw moderationError(
					"INVALID_DATA",
					"Moderation page size must be between 1 and 1000",
				);
			for (const [key, field] of [
				["subject_id", "subjectId"],
				["attempt_id", "attemptId"],
				["after", "recordKey"],
			] as const) {
				const value = query[key];
				if (value !== undefined) {
					identifier(value);
					where.push({ field, value, operator: key === "after" ? "gt" : "eq" });
				}
			}
			if (query.before !== undefined)
				where.push({
					field: "createdAt",
					value: isoDate(query.before),
					operator: "lt",
				});
			if (query.since !== undefined)
				where.push({
					field: "createdAt",
					value: isoDate(query.since),
					operator: "gte",
				});
			const rows = await db.findMany<Row>({
				model: "moderationRecord",
				where,
				limit: query.limit,
				sortBy: { field: "recordKey", direction: "asc" },
			});
			return rows.map((row) => decode<T>(row));
		},
		async insert<T extends object>(input: RecordInput<T>) {
			selector(tenant_id, input.kind, input.key);
			if (input.subject_id !== null) identifier(input.subject_id);
			if (input.attempt_id !== null) identifier(input.attempt_id);
			const serialized = payload(input.data);
			const existing = await get<T>(input.kind, input.key);
			if (existing) {
				if (
					canonical(existing.data) !== serialized ||
					existing.subject_id !== input.subject_id ||
					existing.attempt_id !== input.attempt_id
				)
					throw moderationError(
						"IDEMPOTENCY_CONFLICT",
						"Moderation record key has already been used",
					);
				return existing;
			}
			const row = await db.create<Omit<Row, "id">, Row>({
				model: "moderationRecord",
				data: {
					tenantId: tenant_id,
					kind: input.kind,
					recordKey: input.key,
					subjectId: input.subject_id,
					attemptId: input.attempt_id,
					payload: serialized,
					revision: 0,
					createdAt: new Date(),
				},
			});
			return decode<T>(row);
		},
		async replace<T extends object>(record: StoredRecord<T>, data: T) {
			if (record.tenant_id !== tenant_id)
				throw moderationError(
					"FORBIDDEN",
					"Moderation record belongs to another tenant",
				);
			if (!mutable.has(record.kind))
				throw moderationError(
					"IMMUTABLE_RECORD",
					"Moderation evidence cannot be replaced",
				);
			if (!Number.isSafeInteger(record.revision) || record.revision < 0)
				throw moderationError(
					"INVALID_DATA",
					"Invalid moderation record revision",
				);
			const affected = await db.updateMany({
				model: "moderationRecord",
				where: [
					...selector(tenant_id, record.kind, record.key),
					{ field: "id", value: record.id },
					{ field: "revision", value: record.revision },
				],
				update: { payload: payload(data), revision: record.revision + 1 },
			});
			if (affected !== 1)
				throw moderationError(
					"STATE_CONFLICT",
					"Moderation record has changed",
				);
			const updated = await get<T>(record.kind, record.key);
			if (!updated)
				throw moderationError(
					"STATE_CONFLICT",
					"Moderation record is missing after update",
				);
			return updated;
		},
		async remove(kind, key) {
			await db.delete({
				model: "moderationRecord",
				where: selector(tenant_id, kind, key),
			});
		},
	};
}

/** SQL-backed tenant isolation, immutable evidence and revision-guarded writes. */
export function createModerationStore<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
): ModerationStorage {
	if (
		adapter.id === "memory" ||
		typeof adapter.options?.adapterConfig.transaction !== "function"
	)
		throw moderationError(
			"INVALID_STORAGE",
			"Moderation requires a SQL adapter with real transactions and unique indexes",
		);
	async function ensureLock(tenant_id: string) {
		const where = [{ field: "tenantId", value: tenant_id }];
		if (await adapter.findOne({ model: "moderationTenantLock", where })) return;
		try {
			await adapter.create({
				model: "moderationTenantLock",
				data: { tenantId: tenant_id, revision: 0 },
			});
		} catch (error) {
			// Check a competing committed insert outside the PostgreSQL transaction.
			if (!(await adapter.findOne({ model: "moderationTenantLock", where })))
				throw error;
			return;
		}
		if (!(await adapter.findOne({ model: "moderationTenantLock", where })))
			throw moderationError(
				"STATE_CONFLICT",
				"Moderation tenant lock was not committed",
			);
	}
	return {
		get: (tenant_id, kind, key) => scoped(adapter, tenant_id).get(kind, key),
		list: (tenant_id, kind, query) =>
			scoped(adapter, tenant_id).list(kind, query),
		async transaction(tenant_id, work) {
			identifier(tenant_id);
			await ensureLock(tenant_id);
			return adapter.transaction(async (db) => {
				// shortcut: serialize tenant writes; split locks after measuring contention.
				const lock = await db.incrementOne({
					model: "moderationTenantLock",
					where: [{ field: "tenantId", value: tenant_id }],
					increment: { revision: 1 },
				});
				if (!lock)
					throw moderationError(
						"STATE_CONFLICT",
						"Moderation tenant lock is missing",
					);
				return work(scoped(db, tenant_id));
			});
		},
	};
}
