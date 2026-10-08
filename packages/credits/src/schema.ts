import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";

function integerFromDatabase(value: unknown): number {
	if (
		(typeof value !== "number" &&
			typeof value !== "bigint" &&
			typeof value !== "string") ||
		(typeof value === "string" && !/^-?\d+$/.test(value))
	) {
		throw new Error("Credits database values must be safe integers");
	}
	const result = Number(value);
	if (!Number.isSafeInteger(result)) {
		throw new Error("Credits database values must be safe integers");
	}
	return result;
}

/**
 * Create the authoritative append-only ledger and its required unique indexes.
 * Ledger rows must never be edited or deleted: balances and concurrency depend on them.
 */
export function createCreditsSchema() {
	return {
		creditEntry: {
			fields: {
				referenceId: { type: "string", required: true },
				amount: {
					type: "number",
					bigint: true,
					required: true,
					transform: { output: integerFromDatabase },
				},
				balance: {
					type: "number",
					bigint: true,
					required: true,
					transform: { output: integerFromDatabase },
				},
				sequence: {
					type: "number",
					bigint: true,
					required: true,
					transform: { output: integerFromDatabase },
				},
				idempotencyKey: { type: "string", required: true },
				reason: { type: "string", required: false },
				kind: { type: "string", required: false },
				source: { type: "string", required: false },
				expiresAt: { type: "date", required: false },
				batchState: { type: "string", required: false, returned: false },
				revokedGrantKey: { type: "string", required: false, returned: false },
				createdAt: { type: "date", required: true },
			},
			indexes: [
				{ fields: ["referenceId", "sequence"], unique: true },
				{ fields: ["referenceId", "idempotencyKey"], unique: true },
			],
		},
	} satisfies BetterAuthPluginDBSchema;
}
