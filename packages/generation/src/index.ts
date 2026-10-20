import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth";
import {
	createAuthEndpoint,
	createAuthMiddleware,
	getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { generationProviderError } from "./primitives";
import { generationSchema } from "./schema";
import { createGenerationService } from "./service";
import type { GenerationOptions } from "./types";
import {
	createBody,
	detailQuery,
	listQuery,
	notificationBody,
	reconcileBody,
} from "./validation";

export type * from "./types";
export { createGenerationService, generationProviderError, generationSchema };

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		generation: { creator: typeof generation };
	}
}

/** Add owner-scoped generation endpoints to the host's existing authentication route. */
export function generation(options: GenerationOptions) {
	const authorize = createAuthMiddleware(async (ctx) => {
		ctx.setHeader("Cache-Control", "no-store");
		const session = await getAuthoritativeSessionFromCtx(ctx);
		if (!session)
			throw new APIError("UNAUTHORIZED", {
				message: "Authentication required",
			});
		if (
			("banned" in session.user && session.user.banned) ||
			("impersonatedBy" in session.session && session.session.impersonatedBy)
		)
			throw new APIError("FORBIDDEN", {
				message: "Generation is unavailable for this session",
			});
		return { generationUserId: session.user.id };
	});
	const read = {
		method: "GET" as const,
		requireHeaders: true,
		use: [authorize],
		metadata: { noStore: true },
	};
	const write = { ...read, method: "POST" as const };
	return {
		id: "generation",
		options,
		schema: generationSchema,
		init(ctx) {
			createGenerationService(ctx.adapter, options);
		},
		endpoints: {
			listGenerationModels: createAuthEndpoint(
				"/generation/models",
				read,
				async (ctx) =>
					ctx.json(
						createGenerationService(ctx.context.adapter, options).models(),
					),
			),
			createGenerationTask: createAuthEndpoint(
				"/generation/create",
				{ ...write, body: createBody },
				async (ctx) =>
					ctx.json(
						await createGenerationService(ctx.context.adapter, options).create(
							ctx.context.generationUserId,
							ctx.body,
						),
					),
			),
			getGenerationTask: createAuthEndpoint(
				"/generation/get",
				{ ...read, query: detailQuery },
				async (ctx) =>
					ctx.json(
						await createGenerationService(ctx.context.adapter, options).get(
							ctx.context.generationUserId,
							ctx.query.jobId,
						),
					),
			),
			listGenerationTasks: createAuthEndpoint(
				"/generation/list",
				{ ...read, query: listQuery },
				async (ctx) =>
					ctx.json(
						await createGenerationService(ctx.context.adapter, options).list(
							ctx.context.generationUserId,
							ctx.query,
						),
					),
			),
			cancelGenerationTask: createAuthEndpoint(
				"/generation/cancel",
				{ ...write, body: detailQuery },
				async (ctx) =>
					ctx.json(
						await createGenerationService(ctx.context.adapter, options).cancel(
							ctx.context.generationUserId,
							ctx.body.jobId,
						),
					),
			),
			/** Host scheduler only; this operation has no HTTP route. */
			runGenerationTasks: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true } },
				async (ctx) =>
					createGenerationService(ctx.context.adapter, options).run(),
			),
			/** Verified notifications only wake polling; no caller-supplied result is accepted. */
			notifyGenerationTask: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					metadata: { SERVER_ONLY: true },
					body: notificationBody,
				},
				async (ctx) =>
					createGenerationService(ctx.context.adapter, options).notify(
						ctx.body,
					),
			),
			inspectGenerationTask: createAuthEndpoint.serverOnly(
				{ method: "POST", metadata: { SERVER_ONLY: true }, body: detailQuery },
				async (ctx) =>
					createGenerationService(ctx.context.adapter, options).inspect(
						ctx.body.jobId,
					),
			),
			reconcileGenerationTask: createAuthEndpoint.serverOnly(
				{
					method: "POST",
					metadata: { SERVER_ONLY: true },
					body: reconcileBody,
				},
				async (ctx) =>
					createGenerationService(ctx.context.adapter, options).reconcile(
						ctx.body,
					),
			),
		},
	} satisfies BetterAuthPlugin;
}
