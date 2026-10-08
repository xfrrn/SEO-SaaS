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
import {
	createCreditsService,
	grantBody,
	identifier,
	mutationBody,
	queryInteger,
	revokeBody,
} from "./service";

export { createCreditsService } from "./service";
export type {
	CreditEntry,
	CreditGrantInput,
	CreditMutationInput,
	CreditRevokeInput,
	PublicCreditEntry,
} from "./types";

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

/**
 * Manage permanent or expiring credits with one authoritative append-only ledger.
 * Required unique indexes serialize concurrent operations. Never edit or delete
 * ledger rows, including when removing the associated user account.
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

	return {
		id: "credits",
		options,
		schema: mergeSchema(createCreditsSchema(), options.schema),
		init(ctx) {
			createCreditsService(ctx.adapter);
		},
		endpoints: {
			/** Add credits once per account and idempotency key, from trusted server code. */
			grantCredits: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: grantBody },
				async (ctx) =>
					createCreditsService(ctx.context.adapter).grant(ctx.body),
			),
			/** Consume credits atomically; an account's balance cannot become negative. */
			consumeCredits: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: mutationBody },
				async (ctx) =>
					createCreditsService(ctx.context.adapter).consume(ctx.body),
			),
			/** Recover only the remaining unexpired portion of an original grant. */
			revokeCreditsGrant: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: revokeBody },
				async (ctx) =>
					createCreditsService(ctx.context.adapter).revokeGrant(ctx.body),
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
					return ctx.json(
						await createCreditsService(ctx.context.adapter).balance(
							referenceId,
						),
					);
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
					return ctx.json(
						await createCreditsService(ctx.context.adapter).ledger({
							referenceId,
							cursor: ctx.query?.cursor,
							limit: ctx.query?.limit,
						}),
					);
				},
			),
		},
	} satisfies BetterAuthPlugin;
}
