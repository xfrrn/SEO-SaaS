import type { DBTransactionAdapter } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import type { BetterAuthPluginDBSchema } from "better-auth/db";
import type { MediaEngineActionEvent } from "./media-engine-types";
import { mediaActionEventSchema } from "./media-engine-types";

export const mediaEngineActionReceiptSchema = {
	mediaEngineActionReceipt: {
		fields: {
			actionId: { type: "string", required: true },
			userId: { type: "string", required: true },
			binding: { type: "string", required: true },
			status: { type: "string", required: true },
			reasonCode: { type: "string", required: true },
			createdAt: { type: "date", required: true },
		},
		indexes: [{ fields: ["actionId"], unique: true }],
	},
} satisfies BetterAuthPluginDBSchema;
type Receipt = {
	id: string;
	binding: string;
	status: "succeeded" | "failed";
	reasonCode: string;
};

/** The host verifies the signed event and calls this inside its inbox SQL transaction. */
export async function applyMediaEngineAction<Options extends BetterAuthOptions>(
	tx: DBTransactionAdapter<Options>,
	event: MediaEngineActionEvent,
) {
	event = mediaActionEventSchema.parse(event);
	const binding = JSON.stringify([
		event.application_id,
		event.external_user_id,
		event.action_id,
		event.attempt_id,
		event.decision_id,
		event.type,
		Object.entries(event.parameters).sort(([a], [b]) => a.localeCompare(b)),
		event.expires_at,
	]);
	const prior = await tx.findOne<Receipt>({
		model: "mediaEngineActionReceipt",
		where: [{ field: "actionId", value: event.action_id }],
	});
	if (prior) {
		if (prior.binding !== binding) throw new Error("MEDIA_ACTION_CONFLICT");
		return { status: prior.status, reason_code: prior.reasonCode };
	}
	const user = await tx.findOne<{ id: string; role?: string }>({
		model: "user",
		where: [{ field: "id", value: event.external_user_id }],
	});
	let status: "succeeded" | "failed" = "failed",
		reasonCode = "ACTION_UNSUPPORTED_TYPE";
	if (!user) reasonCode = "ACTION_USER_NOT_FOUND";
	else if (Date.parse(event.expires_at) <= Date.now())
		reasonCode = "ACTION_EXPIRED";
	else if (user.role?.split(",").includes("admin"))
		reasonCode = "ACTION_ADMIN_REVIEW_REQUIRED";
	else if (event.type === "ban" || event.type === "revoke_session") {
		if (event.type === "ban")
			await tx.update({
				model: "user",
				where: [{ field: "id", value: user.id }],
				update: {
					banned: true,
					banReason: `media:${event.action_id}`,
					banExpires: null,
				},
			});
		await tx.deleteMany({
			model: "session",
			where: [{ field: "userId", value: user.id }],
		});
		status = "succeeded";
		reasonCode = "ACTION_APPLIED";
	}
	await tx.create({
		model: "mediaEngineActionReceipt",
		data: {
			actionId: event.action_id,
			userId: event.external_user_id,
			binding,
			status,
			reasonCode,
			createdAt: new Date(),
		},
	});
	return { status, reason_code: reasonCode };
}
