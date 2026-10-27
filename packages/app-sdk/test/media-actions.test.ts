import { getTestInstance } from "better-auth/test";
import { admin } from "better-auth/plugins";
import { expect, it } from "vitest";
import {
	applyMediaEngineAction,
	mediaEngineActionReceiptSchema,
} from "../src/media-engine-actions";
import type { MediaEngineActionEvent } from "../src/media-engine-types";

it("applies website enforcement with its receipt in one transaction and never repeats after an unban", async () => {
	const instance = await getTestInstance(
		{
			plugins: [
				admin(),
				{ id: "media-actions", schema: mediaEngineActionReceiptSchema },
			],
		},
		{ testWith: "sqlite" },
	);
	const { user } = await instance.signInWithTestUser();
	const { adapter } = await instance.auth.$context;
	const event: MediaEngineActionEvent = {
		event_version: 2,
		event_id: "evt-action-1",
		event: "moderation.action",
		application_id: "app1",
		external_user_id: user.id,
		action_id: "action1",
		attempt_id: "attempt1",
		decision_id: "decision1",
		type: "ban",
		parameters: {},
		expires_at: new Date(Date.now() + 60000).toISOString(),
		reason_code: "ACTION_REQUIRED",
	};
	await expect(
		adapter.transaction(async (tx) => {
			await applyMediaEngineAction(tx, event);
			throw new Error("INBOX_WRITE_FAILED");
		}),
	).rejects.toThrow("INBOX_WRITE_FAILED");
	expect(
		(
			await adapter.findOne<{ banned?: boolean }>({
				model: "user",
				where: [{ field: "id", value: user.id }],
			})
		)?.banned,
	).not.toBe(true);
	expect(await adapter.count({ model: "mediaEngineActionReceipt" })).toBe(0);
	expect(
		await adapter.transaction((tx) => applyMediaEngineAction(tx, event)),
	).toEqual({ status: "succeeded", reason_code: "ACTION_APPLIED" });
	expect(
		await adapter.count({
			model: "session",
			where: [{ field: "userId", value: user.id }],
		}),
	).toBe(0);
	await adapter.update({
		model: "user",
		where: [{ field: "id", value: user.id }],
		update: { banned: false },
	});
	await adapter.transaction((tx) => applyMediaEngineAction(tx, event));
	expect(
		(
			await adapter.findOne<{ banned: boolean }>({
				model: "user",
				where: [{ field: "id", value: user.id }],
			})
		)?.banned,
	).toBe(false);
	await expect(
		adapter.transaction((tx) =>
			applyMediaEngineAction(tx, { ...event, type: "revoke_session" }),
		),
	).rejects.toThrow("MEDIA_ACTION_CONFLICT");
	const unsupported = await adapter.transaction((tx) =>
		applyMediaEngineAction(tx, {
			...event,
			action_id: "action2",
			type: "challenge",
		}),
	);
	expect(unsupported).toEqual({
		status: "failed",
		reason_code: "ACTION_UNSUPPORTED_TYPE",
	});
});
