import type { DBAdapter } from "@better-auth/core/db/adapter";
import type {
	BetterAuthPlugin,
	GenericEndpointContext,
	InferOptionSchema,
	Session,
	User,
} from "better-auth";
import { APIError } from "better-auth";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { mergeSchema } from "better-auth/db";
import * as z from "zod";
import { createCreditsSchema } from "./schema";
import type { CreditEntry, PublicCreditEntry } from "./types";

export type { CreditEntry, PublicCreditEntry } from "./types";

/** Configure authorization for shared accounts and optional database mappings. */
export interface CreditsOptions {
	/** Authorize reads for references other than the current authenticated user. */
	authorizeReference?: (
		data: { user: User; session: Session; referenceId: string },
		ctx: GenericEndpointContext,
	) => boolean | Promise<boolean>;
	schema?: InferOptionSchema<ReturnType<typeof createCreditsSchema>>;
}

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		credits: { creator: typeof credits };
	}
}

const identifier = z
	.string()
	.min(1)
	.max(255)
	.refine((value) => value === value.trim(), {
		message: "Identifiers must not have leading or trailing whitespace",
	});
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const queryInteger = z
	.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
	.pipe(positiveInteger);
const mutationBody = z.object({
	referenceId: identifier,
	amount: positiveInteger,
	idempotencyKey: identifier,
	reason: z.string().max(500).optional(),
});

function publicEntry(entry: CreditEntry): PublicCreditEntry {
	return {
		id: entry.id,
		referenceId: entry.referenceId,
		amount: entry.amount,
		balance: entry.balance,
		sequence: entry.sequence,
		reason: entry.reason,
		createdAt: entry.createdAt,
	};
}

async function lastEntry(adapter: DBAdapter, referenceId: string) {
	const [entry] = await adapter.findMany<CreditEntry>({
		model: "creditEntry",
		where: [{ field: "referenceId", value: referenceId }],
		sortBy: { field: "sequence", direction: "desc" },
		limit: 1,
	});
	if (
		entry &&
		(!Number.isSafeInteger(entry.balance) ||
			entry.balance < 0 ||
			!Number.isSafeInteger(entry.sequence) ||
			entry.sequence < 1)
	) {
		throw new Error("Credits ledger contains an invalid balance or sequence");
	}
	return entry;
}

/**
 * Manage nonexpiring credits with a single authoritative, append-only ledger.
 * The database must enforce both unique indexes; they serialize concurrent
 * operations without balance/ledger dual writes or application-process locks.
 * Call grants and consumption only from trusted server code. Never edit or
 * delete ledger rows, including when removing the associated user account.
 */
export function credits(options: CreditsOptions = {}) {
	async function authorize(
		data: { user: User; session: Session; referenceId: string },
		ctx: GenericEndpointContext,
	) {
		if (
			data.referenceId !== data.user.id &&
			!(await options.authorizeReference?.(data, ctx))
		) {
			throw new APIError("FORBIDDEN", {
				message: "Not authorized to read these credits",
			});
		}
	}

	async function append(
		adapter: DBAdapter,
		body: z.infer<typeof mutationBody>,
		direction: 1 | -1,
	) {
		const amount = direction * body.amount;
		const findExisting = () =>
			adapter.findOne<CreditEntry>({
				model: "creditEntry",
				where: [
					{ field: "referenceId", value: body.referenceId },
					{ field: "idempotencyKey", value: body.idempotencyKey },
				],
			});
		function duplicate(entry: CreditEntry) {
			if (
				entry.amount !== amount ||
				(entry.reason ?? null) !== (body.reason ?? null)
			) {
				throw new APIError("CONFLICT", {
					code: "CREDITS_IDEMPOTENCY_CONFLICT",
					message:
						"The idempotency key was already used for a different credit operation",
				});
			}
			return { entry, applied: false };
		}

		for (let attempt = 0; attempt < 8; attempt++) {
			const previous = await lastEntry(adapter, body.referenceId);
			// Read the key after the balance, so a concurrent successful duplicate
			// cannot be mistaken for a new debit with insufficient remaining credits.
			const existing = await findExisting();
			if (existing) return duplicate(existing);
			const balance = previous?.balance ?? 0;
			if (direction === -1 && body.amount > balance) {
				throw new APIError("BAD_REQUEST", {
					code: "INSUFFICIENT_CREDITS",
					message: "Insufficient credits",
				});
			}
			if (direction === 1 && body.amount > Number.MAX_SAFE_INTEGER - balance) {
				throw new APIError("BAD_REQUEST", {
					code: "CREDITS_BALANCE_OVERFLOW",
					message: "The credit balance would exceed the safe integer limit",
				});
			}
			if (previous?.sequence === Number.MAX_SAFE_INTEGER) {
				throw new APIError("BAD_REQUEST", {
					code: "CREDITS_SEQUENCE_OVERFLOW",
					message: "The credits ledger sequence reached the safe integer limit",
				});
			}
			const sequence = (previous?.sequence ?? 0) + 1;
			try {
				const entry = await adapter.create<
					Omit<CreditEntry, "id">,
					CreditEntry
				>({
					model: "creditEntry",
					data: {
						referenceId: body.referenceId,
						amount,
						balance: balance + amount,
						sequence,
						idempotencyKey: body.idempotencyKey,
						reason: body.reason,
						createdAt: new Date(),
					},
				});
				return { entry, applied: true };
			} catch (error) {
				const committed = await findExisting();
				if (committed) return duplicate(committed);
				const competitor = await adapter.findOne<CreditEntry>({
					model: "creditEntry",
					where: [
						{ field: "referenceId", value: body.referenceId },
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

	return {
		id: "credits",
		options,
		schema: mergeSchema(createCreditsSchema(), options.schema),
		init(ctx) {
			if (ctx.adapter.id === "memory") {
				throw new Error(
					"Credits requires a database adapter that enforces unique indexes; the memory adapter is not supported",
				);
			}
		},
		endpoints: {
			/** Add credits once per account and idempotency key, from trusted server code. */
			grantCredits: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: mutationBody },
				async (ctx) => append(ctx.context.adapter, ctx.body, 1),
			),
			/** Consume credits atomically; an account's balance cannot become negative. */
			consumeCredits: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: mutationBody },
				async (ctx) => append(ctx.context.adapter, ctx.body, -1),
			),
			getCreditsBalance: createAuthEndpoint(
				"/credits/balance",
				{
					method: "GET",
					requireHeaders: true,
					use: [sessionMiddleware],
					query: z.object({ referenceId: identifier.optional() }).optional(),
				},
				async (ctx) => {
					const { user, session } = ctx.context.session;
					const referenceId = ctx.query?.referenceId ?? user.id;
					await authorize({ user, session, referenceId }, ctx);
					const entry = await lastEntry(ctx.context.adapter, referenceId);
					return ctx.json({ referenceId, balance: entry?.balance ?? 0 });
				},
			),
			listCreditsLedger: createAuthEndpoint(
				"/credits/ledger",
				{
					method: "GET",
					requireHeaders: true,
					use: [sessionMiddleware],
					query: z
						.object({
							referenceId: identifier.optional(),
							cursor: queryInteger.optional(),
							limit: queryInteger.pipe(z.number().max(100)).default(20),
						})
						.optional(),
				},
				async (ctx) => {
					const { user, session } = ctx.context.session;
					const referenceId = ctx.query?.referenceId ?? user.id;
					await authorize({ user, session, referenceId }, ctx);
					const limit = ctx.query?.limit ?? 20;
					const cursor = ctx.query?.cursor;
					const rows = await ctx.context.adapter.findMany<CreditEntry>({
						model: "creditEntry",
						where: [
							{ field: "referenceId", value: referenceId },
							...(cursor === undefined
								? []
								: [
										{
											field: "sequence",
											operator: "lt" as const,
											value: cursor,
										},
									]),
						],
						sortBy: { field: "sequence", direction: "desc" },
						limit: limit + 1,
					});
					const entries = rows.slice(0, limit).map(publicEntry);
					return ctx.json({
						entries,
						nextCursor:
							rows.length > limit
								? entries[entries.length - 1]!.sequence
								: null,
					});
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
