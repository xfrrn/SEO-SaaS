import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { moderationSchema } from "./moderation/schema";
import { createModeration } from "./moderation/service";
import { createModerationStore } from "./moderation/storage";
import type { ModerationOptions } from "./moderation/types";
import { authorizationSchema, evaluationSchema } from "./moderation/validation";

export type {
	ConsentRequest,
	ConsentState,
	RevokeConsentRequest,
	VerifyConsentRequest,
} from "./moderation/consents";
export type {
	OpenAIModerationOptions,
	ResolvedVideoInspection,
} from "./moderation/detectors/openai";
export { createOpenAIModerationDetector } from "./moderation/detectors/openai";
export { createTextRulesDetector } from "./moderation/detectors/text-rules";
export type {
	DeliveryRequest,
	FeedbackRequest,
	OutcomeRequest,
	ProviderResultRequest,
} from "./moderation/events";
export type {
	ExportEvidenceRequest,
	PublicPolicyRequest,
} from "./moderation/evidence";
export type {
	CleanupReceipt,
	CleanupRequest,
	ExpireReviewsRequest,
	ListReviewsRequest,
	RunActionsRequest,
} from "./moderation/maintenance";
export { moderationSchema } from "./moderation/schema";
export type {
	CapabilitiesRequest,
	ResolveReviewRequest,
} from "./moderation/service";
export { createModeration } from "./moderation/service";
export { createModerationStore } from "./moderation/storage";
export type * from "./moderation/types";
export { moderationCategories } from "./moderation/validation";

declare module "@better-auth/core" {
	interface BetterAuthPluginRegistry<AuthOptions, Options> {
		moderation: { creator: typeof moderation };
	}
}

/** Optional Better Auth bridge. These operations have no public HTTP routes. */
export function moderation(
	options: Omit<ModerationOptions, "storage"> & {
		storage?: ModerationOptions["storage"];
	},
) {
	return {
		id: "moderation",
		schema: moderationSchema,
		init(ctx) {
			if (!options.storage) createModerationStore(ctx.adapter);
		},
		endpoints: {
			moderateContent: createAuthEndpoint.serverOnly(
				{ method: "POST", body: evaluationSchema },
				async (ctx) =>
					createModeration({
						...options,
						storage:
							options.storage ?? createModerationStore(ctx.context.adapter),
					}).evaluate(ctx.body),
			),
			authorizeModerationOperation: createAuthEndpoint.serverOnly(
				{ method: "POST", body: authorizationSchema },
				async (ctx) =>
					createModeration({
						...options,
						storage:
							options.storage ?? createModerationStore(ctx.context.adapter),
					}).authorizeOperation(ctx.body),
			),
		},
	} satisfies BetterAuthPlugin;
}
