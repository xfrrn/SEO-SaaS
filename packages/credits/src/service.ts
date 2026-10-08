import type { DBAdapter } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth";
import * as z from "zod";
import type {
	CreditEntry,
	CreditGrantInput,
	CreditMutationInput,
	CreditRevokeInput,
	PublicCreditEntry,
} from "./types";

export const identifier = z
	.string()
	.min(1)
	.max(255)
	.refine((value) => value === value.trim(), {
		message: "Identifiers must not have leading or trailing whitespace",
	});
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const queryInteger = z
	.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
	.pipe(positiveInteger);
export const mutationBody = z.object({
	referenceId: identifier,
	amount: positiveInteger,
	idempotencyKey: identifier,
	reason: z.string().max(500).optional(),
});
export const grantBody = mutationBody.extend({
	source: identifier.optional(),
	expiresAt: z.date().optional(),
});
export const revokeBody = mutationBody.omit({ amount: true }).extend({
	grantKey: identifier,
});
const batchSchema = z.array(
	z.object({
		grantKey: identifier,
		remaining: positiveInteger,
		expiresAt: z.number().int().nullable(),
	}),
);
type Batch = z.infer<typeof batchSchema>[number];
type Mutation =
	| ({ kind: "grant" } & CreditGrantInput)
	| ({ kind: "consume" } & CreditMutationInput)
	| ({ kind: "revoke" } & CreditRevokeInput);

function publicEntry(entry: CreditEntry): PublicCreditEntry {
	return {
		id: entry.id,
		referenceId: entry.referenceId,
		amount: entry.amount,
		balance: entry.balance,
		sequence: entry.sequence,
		reason: entry.reason,
		kind: entry.kind,
		source: entry.source,
		expiresAt: entry.expiresAt,
		createdAt: entry.createdAt,
	};
}

function take(batches: Batch[], amount: number) {
	// Stable sorting spends older grants first when their expiration dates match.
	batches.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
	for (const batch of batches) {
		const used = Math.min(batch.remaining, amount);
		batch.remaining -= used;
		amount -= used;
		if (!amount) break;
	}
	if (amount)
		throw new Error("Credits batches do not match the ledger balance");
}

/**
 * Trusted server credit operations using only the supplied adapter.
 * Every change atomically appends its balance and remaining batches in one row.
 * Unique account/sequence and account/key indexes are required; rows are immutable.
 */
export function createCreditsService<Options extends BetterAuthOptions>(
	adapter: DBAdapter<Options>,
) {
	if (adapter.id === "memory") {
		throw new Error(
			"Credits requires a database adapter that enforces unique indexes; the memory adapter is not supported",
		);
	}
	const findKey = (referenceId: string, idempotencyKey: string) =>
		adapter.findOne<CreditEntry>({
			model: "creditEntry",
			where: [
				{ field: "referenceId", value: referenceId },
				{ field: "idempotencyKey", value: idempotencyKey },
			],
		});

	async function state(previous: CreditEntry | undefined): Promise<Batch[]> {
		if (!previous) return [];
		let batches: Batch[];
		if (previous.batchState) {
			batches = batchSchema.parse(JSON.parse(previous.batchState));
		} else {
			// Old ledgers have permanent grants. Replay them once on the next write;
			// never rewrite historical rows or assign consumed credits to a new grant.
			batches = [];
			let cursor = 0;
			while (cursor < previous.sequence) {
				const rows = await adapter.findMany<CreditEntry>({
					model: "creditEntry",
					where: [
						{ field: "referenceId", value: previous.referenceId },
						{ field: "sequence", operator: "gt", value: cursor },
						{ field: "sequence", operator: "lte", value: previous.sequence },
					],
					sortBy: { field: "sequence", direction: "asc" },
					limit: 100,
				});
				if (!rows.length)
					throw new Error("Credits ledger history is incomplete");
				for (const row of rows) {
					if (
						!Number.isSafeInteger(row.amount) ||
						row.sequence !== cursor + 1
					) {
						throw new Error("Credits ledger history is invalid");
					}
					if (row.amount > 0) {
						batches.push({
							grantKey: row.idempotencyKey,
							remaining: row.amount,
							expiresAt: row.expiresAt?.getTime() ?? null,
						});
					} else take(batches, -row.amount);
					cursor = row.sequence;
				}
			}
		}
		const total = batches.reduce((sum, batch) => sum + batch.remaining, 0);
		if (
			!Number.isSafeInteger(total) ||
			total !== previous.balance ||
			new Set(batches.map((batch) => batch.grantKey)).size !== batches.length
		) {
			throw new Error("Credits batches do not match the ledger balance");
		}
		return batches.filter((batch) => batch.remaining > 0);
	}

	function duplicate(entry: CreditEntry, input: Mutation) {
		const kind = entry.kind ?? (entry.amount > 0 ? "grant" : "consume");
		if (
			kind !== input.kind ||
			(entry.reason ?? null) !== (input.reason ?? null) ||
			(input.kind === "revoke"
				? entry.revokedGrantKey !== input.grantKey
				: entry.amount !==
					(input.kind === "grant" ? input.amount : -input.amount)) ||
			(input.kind === "grant" &&
				((entry.source ?? null) !== (input.source ?? null) ||
					(entry.expiresAt?.getTime() ?? null) !==
						(input.expiresAt?.getTime() ?? null)))
		) {
			throw new APIError("CONFLICT", {
				code: "CREDITS_IDEMPOTENCY_CONFLICT",
				message:
					"The idempotency key was already used for a different credit operation",
			});
		}
		return { entry, applied: false };
	}

	async function originalGrant(input: CreditRevokeInput) {
		const grant = await findKey(input.referenceId, input.grantKey);
		if (!grant || grant.amount <= 0 || (grant.kind && grant.kind !== "grant")) {
			throw new APIError("NOT_FOUND", {
				code: "CREDITS_GRANT_NOT_FOUND",
				message: "The original credit grant was not found",
			});
		}
		return grant;
	}

	async function execute(referenceId: string, input?: Mutation) {
		for (let attempt = 0; attempt < 16; attempt++) {
			const [previous] = await adapter.findMany<CreditEntry>({
				model: "creditEntry",
				where: [{ field: "referenceId", value: referenceId }],
				sortBy: { field: "sequence", direction: "desc" },
				limit: 1,
			});
			if (
				previous &&
				(!Number.isSafeInteger(previous.balance) ||
					previous.balance < 0 ||
					!Number.isSafeInteger(previous.sequence) ||
					previous.sequence < 1)
			)
				throw new Error(
					"Credits ledger contains an invalid balance or sequence",
				);
			// Read the key after the balance so racing successful retries cannot fail
			// as new debits due to a subsequently depleted balance.
			if (input) {
				const existing = await findKey(referenceId, input.idempotencyKey);
				if (existing) return duplicate(existing, input);
			}
			let batches = await state(previous);
			const now = new Date();
			const expired = batches.reduce(
				(sum, batch) =>
					sum +
					(batch.expiresAt !== null && batch.expiresAt <= now.getTime()
						? batch.remaining
						: 0),
				0,
			);
			if (!expired && !input) return { entry: previous, applied: false };
			if (previous?.sequence === Number.MAX_SAFE_INTEGER) {
				throw new APIError("BAD_REQUEST", {
					code: "CREDITS_SEQUENCE_OVERFLOW",
					message: "The credits ledger sequence reached the safe integer limit",
				});
			}
			const sequence = (previous?.sequence ?? 0) + 1;
			const balance = previous?.balance ?? 0;
			let amount: number;
			if (expired) {
				amount = -expired;
				batches = batches.filter(
					(batch) =>
						batch.expiresAt === null || batch.expiresAt > now.getTime(),
				);
			} else if (input?.kind === "grant") {
				amount = input.amount;
				if (amount > Number.MAX_SAFE_INTEGER - balance) {
					throw new APIError("BAD_REQUEST", {
						code: "CREDITS_BALANCE_OVERFLOW",
						message: "The credit balance would exceed the safe integer limit",
					});
				}
				batches.push({
					grantKey: input.idempotencyKey,
					remaining: amount,
					expiresAt: input.expiresAt?.getTime() ?? null,
				});
			} else if (input?.kind === "consume") {
				if (input.amount > balance) {
					throw new APIError("BAD_REQUEST", {
						code: "INSUFFICIENT_CREDITS",
						message: "Insufficient credits",
					});
				}
				amount = -input.amount;
				take(batches, input.amount);
			} else if (input?.kind === "revoke") {
				await originalGrant(input);
				amount = -(
					batches.find((batch) => batch.grantKey === input.grantKey)
						?.remaining ?? 0
				);
				batches = batches.filter((batch) => batch.grantKey !== input.grantKey);
			} else throw new Error("Missing credit operation");

			// Leading whitespace is rejected by all public identifiers, so internal
			// expiry keys cannot collide with caller-provided idempotency keys.
			const key = expired
				? ` credits:expiry:${sequence}`
				: input!.idempotencyKey;
			try {
				const entry = await adapter.create<
					Omit<CreditEntry, "id">,
					CreditEntry
				>({
					model: "creditEntry",
					data: {
						referenceId,
						amount: amount || 0,
						balance: balance + amount,
						sequence,
						idempotencyKey: key,
						reason: expired ? "Credits expired" : input!.reason,
						kind: expired ? "expire" : input!.kind,
						source:
							!expired && input?.kind === "grant" ? input.source : undefined,
						expiresAt:
							!expired && input?.kind === "grant" ? input.expiresAt : undefined,
						revokedGrantKey:
							!expired && input?.kind === "revoke" ? input.grantKey : undefined,
						// ponytail: snapshot size grows with active grants; use transactional
						// batch rows if accounts routinely retain thousands of active grants.
						batchState: JSON.stringify(
							batches.filter((batch) => batch.remaining > 0),
						),
						createdAt: now,
					},
				});
				if (!expired) return { entry, applied: true };
			} catch (error) {
				if (!expired) {
					const committed = await findKey(referenceId, key);
					if (committed) return duplicate(committed, input!);
				}
				const competitor = await adapter.findOne<CreditEntry>({
					model: "creditEntry",
					where: [
						{ field: "referenceId", value: referenceId },
						{ field: "sequence", value: sequence },
					],
				});
				if (!competitor) throw error;
			}
		}
		throw new APIError("CONFLICT", {
			code: "CREDITS_CONCURRENT_UPDATE",
			message:
				"Concurrent credit operations exceeded the retry limit; retry with the same idempotency key",
		});
	}

	async function mutate(input: Mutation) {
		const result = await execute(input.referenceId, input);
		if (!result.entry) throw new Error("Missing credit ledger entry");
		return { entry: result.entry, applied: result.applied };
	}

	return {
		/** Grant a batch once. Historical expiry dates are accepted for delayed payment events. */
		grant: async (input: CreditGrantInput) =>
			mutate({ ...grantBody.parse(input), kind: "grant" }),
		/** Consume available batches in earliest-expiry order, without overdrawing. */
		consume: async (input: CreditMutationInput) =>
			mutate({ ...mutationBody.parse(input), kind: "consume" }),
		/** Recover a single grant's remaining valid credits; never debit other grants. */
		async revokeGrant(input: CreditRevokeInput) {
			const body = revokeBody.parse(input);
			const result = await mutate({ ...body, kind: "revoke" });
			const grant = await originalGrant(body);
			return {
				...result,
				recovered: -result.entry.amount || 0,
				unavailable: grant.amount + result.entry.amount,
			};
		},
		/** Return spendable balance, recording any newly expired credits first. */
		async balance(referenceId: string) {
			const { entry } = await execute(identifier.parse(referenceId));
			return { referenceId, balance: entry?.balance ?? 0 };
		},
		/** Read immutable public ledger entries with cursor pagination. */
		async ledger(input: {
			referenceId: string;
			cursor?: number | undefined;
			limit?: number | undefined;
		}) {
			const body = z
				.object({
					referenceId: identifier,
					cursor: positiveInteger.optional(),
					limit: positiveInteger.max(100).default(20),
				})
				.parse(input);
			await execute(body.referenceId);
			const rows = await adapter.findMany<CreditEntry>({
				model: "creditEntry",
				where: [
					{ field: "referenceId", value: body.referenceId },
					...(body.cursor === undefined
						? []
						: [
								{
									field: "sequence",
									operator: "lt" as const,
									value: body.cursor,
								},
							]),
				],
				sortBy: { field: "sequence", direction: "desc" },
				limit: body.limit + 1,
			});
			const entries = rows.slice(0, body.limit).map(publicEntry);
			return {
				entries,
				nextCursor:
					rows.length > body.limit
						? entries[entries.length - 1]!.sequence
						: null,
			};
		},
	};
}
