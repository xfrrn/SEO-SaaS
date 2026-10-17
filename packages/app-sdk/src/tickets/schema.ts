import type { BetterAuthPluginDBSchema } from "@better-auth/core/db";

/** Feedback survives account removal; owner IDs never come from a request body. */
export const ticketSchema = {
	supportTicket: {
		fields: {
			userId: { type: "string", required: true, index: true },
			title: { type: "string", required: true },
			content: { type: "string", required: true },
			status: { type: "string", required: true, index: true },
			revision: { type: "number", required: true },
			idempotencyKey: { type: "string", required: true },
			createdAt: { type: "date", required: true },
			updatedAt: { type: "date", required: true, index: true },
		},
		indexes: [{ fields: ["userId", "idempotencyKey"], unique: true }],
	},
	supportTicketEntry: {
		fields: {
			ticketId: {
				type: "string",
				required: true,
				references: {
					model: "supportTicket",
					field: "id",
					onDelete: "cascade",
				},
			},
			authorId: { type: "string", required: true },
			authorRole: { type: "string", required: true },
			kind: { type: "string", required: true },
			content: { type: "string", required: false },
			status: { type: "string", required: false },
			sequence: { type: "number", required: true },
			idempotencyKey: { type: "string", required: true },
			createdAt: { type: "date", required: true },
		},
		indexes: [
			{ fields: ["ticketId", "sequence"], unique: true },
			{ fields: ["authorId", "idempotencyKey"], unique: true },
		],
	},
} satisfies BetterAuthPluginDBSchema;
