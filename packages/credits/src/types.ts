/** One immutable ledger operation; balance is the resulting account balance. */
export interface CreditEntry {
	id: string;
	referenceId: string;
	/** Positive for a grant, negative for consumption. */
	amount: number;
	balance: number;
	/** Strictly increasing sequence within this account, starting at one. */
	sequence: number;
	idempotencyKey: string;
	reason?: string | null | undefined;
	createdAt: Date;
}

/** Ledger details visible to an authorized customer, without internal request keys. */
export type PublicCreditEntry = Omit<CreditEntry, "idempotencyKey">;
