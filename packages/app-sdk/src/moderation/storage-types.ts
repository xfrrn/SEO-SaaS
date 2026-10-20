export type RecordKind =
	| "policy"
	| "capability"
	| "attempt"
	| "report"
	| "decision"
	| "event"
	| "command"
	| "action"
	| "consent"
	| "counter"
	| "cleanup";
export interface StoredRecord<T extends object = Record<string, unknown>> {
	id: string;
	tenant_id: string;
	kind: RecordKind;
	key: string;
	subject_id: string | null;
	attempt_id: string | null;
	data: T;
	revision: number;
	created_at: string;
}
export interface RecordInput<T extends object> {
	kind: RecordKind;
	key: string;
	subject_id: string | null;
	attempt_id: string | null;
	data: T;
}
export interface RecordQuery {
	subject_id?: string;
	attempt_id?: string;
	after?: string;
	before?: string;
	since?: string;
	limit: number;
}
/** Physical storage may combine logical records; all access is tenant-scoped. */
export interface ModerationTransaction {
	get<T extends object>(
		kind: RecordKind,
		key: string,
	): Promise<StoredRecord<T> | null>;
	insert<T extends object>(input: RecordInput<T>): Promise<StoredRecord<T>>;
	replace<T extends object>(
		record: StoredRecord<T>,
		data: T,
	): Promise<StoredRecord<T>>;
	remove(kind: RecordKind, key: string): Promise<void>;
	list<T extends object>(
		kind: RecordKind,
		query: RecordQuery,
	): Promise<StoredRecord<T>[]>;
}
export interface ModerationStorage {
	transaction<T>(
		tenant_id: string,
		work: (tx: ModerationTransaction) => Promise<T>,
	): Promise<T>;
	get<T extends object>(
		tenant_id: string,
		kind: RecordKind,
		key: string,
	): Promise<StoredRecord<T> | null>;
	list<T extends object>(
		tenant_id: string,
		kind: RecordKind,
		query: RecordQuery,
	): Promise<StoredRecord<T>[]>;
}
