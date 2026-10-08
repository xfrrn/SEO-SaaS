import type {
	BetterAuthPluginDBSchema,
	DBFieldAttribute,
} from "@better-auth/core/db";

const json = {
	type: "json",
	required: false,
	input: false,
	returned: false,
	transform: {
		output: (value: unknown) =>
			typeof value === "string" ? JSON.parse(value) : value,
	},
} satisfies DBFieldAttribute;

export const monitorUserFields = {
	monitorSignup: json,
	monitorSiteId: {
		type: "string",
		required: false,
		input: false,
		returned: false,
		index: true,
	},
	monitorSignupPending: {
		type: "boolean",
		required: false,
		input: false,
		returned: false,
		defaultValue: false,
		index: true,
	},
} satisfies Record<string, DBFieldAttribute>;

export const monitorOrderFields = { monitorContext: json };

/** Durable delivery state is retained when monitoring is disabled. */
export const monitorSchema = {
	user: { fields: monitorUserFields },
	businessMonitorEvent: {
		fields: {
			eventId: { type: "string", required: true, unique: true },
			eventKey: { type: "string", required: true, unique: true },
			siteId: { type: "string", required: true, index: true },
			eventType: { type: "string", required: true },
			userId: { type: "string", required: true, index: true },
			orderId: { type: "string", required: false, index: true },
			payload: { ...json, required: true },
			status: { type: "string", required: true },
			attempts: { type: "number", required: true },
			nextAttemptAt: { type: "date", required: false },
			firstAttemptAt: { type: "date", required: false },
			lastAttemptAt: { type: "date", required: false },
			leaseToken: { type: "string", required: false },
			leaseExpiresAt: { type: "date", required: false },
			lastError: { type: "string", required: false },
			lastHttpStatus: { type: "number", required: false },
			deliveredAt: { type: "date", required: false },
			createdAt: { type: "date", required: true },
		},
		indexes: [
			{ fields: ["siteId", "status", "nextAttemptAt"] },
			{ fields: ["siteId", "status", "leaseExpiresAt"] },
		],
	},
} satisfies BetterAuthPluginDBSchema;
