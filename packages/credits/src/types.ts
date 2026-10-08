/** One immutable ledger operation; balance is the resulting account balance. */
export interface CreditEntry {
	id: string;
	referenceId: string;
	/** Positive for a grant, negative for consumption, expiry, or recovery. */
	amount: number;
	balance: number;
	/** Strictly increasing sequence within this account, starting at one. */
	sequence: number;
	idempotencyKey: string;
	reason?: string | null | undefined;
	/** Absent on ledger entries written before batch support. */
	kind?: "grant" | "consume" | "expire" | "revoke" | null | undefined;
	/** Application-defined origin, for example purchase or membership. */
	source?: string | null | undefined;
	/** A grant is unavailable at and after this time. Omitted grants never expire. */
	expiresAt?: Date | null | undefined;
	/** Internal remaining-batch snapshot, committed atomically with the balance. */
	batchState?: string | null | undefined;
	/** Internal original grant key for a recovery operation. */
	revokedGrantKey?: string | null | undefined;
	createdAt: Date;
}

/** Ledger details visible to an authorized customer, without internal request keys. */
export type PublicCreditEntry = Omit<
	CreditEntry,
	"idempotencyKey" | "batchState" | "revokedGrantKey"
>;

/** A trusted server operation, unique per account and idempotency key. */
export interface CreditMutationInput {
	referenceId: string;
	amount: number;
	idempotencyKey: string;
	reason?: string | undefined;
}

/** Add an independently recoverable batch of credits. */
export interface CreditGrantInput extends CreditMutationInput {
	source?: string | undefined;
	expiresAt?: Date | undefined;
}

/** Recover only the unspent, unexpired remainder of one original grant. */
export interface CreditRevokeInput {
	referenceId: string;
	grantKey: string;
	idempotencyKey: string;
	reason?: string | undefined;
}
