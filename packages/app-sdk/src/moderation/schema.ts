import type { BetterAuthPluginDBSchema } from "better-auth/db";

/** Tenant-scoped records retain versioned evidence without storing media bytes. */
export const moderationSchema = {
	moderationRecord: {
		fields: {
			tenantId: { type: "string", required: true },
			kind: { type: "string", required: true },
			recordKey: { type: "string", required: true },
			subjectId: { type: "string", required: false },
			attemptId: { type: "string", required: false },
			payload: { type: "string", required: true },
			revision: { type: "number", required: true },
			createdAt: { type: "date", required: true },
		},
		indexes: [
			{ fields: ["tenantId", "kind", "recordKey"], unique: true },
			{ fields: ["tenantId", "kind", "subjectId"] },
			{ fields: ["tenantId", "kind", "attemptId"] },
			{ fields: ["tenantId", "kind", "createdAt"] },
		],
	},
	moderationTenantLock: {
		fields: {
			tenantId: { type: "string", required: true, unique: true },
			revision: { type: "number", required: true },
		},
	},
} satisfies BetterAuthPluginDBSchema;
