import { getTestInstance } from "better-auth/test";
import { describe, expect, it, vi } from "vitest";
import { admin } from "./admin";
import { createAdminAuditService } from "./audit";
import { adminClient } from "./client";

const input = {
	operationId: "adjustment-1",
	actorId: "operator",
	action: "credits.adjust",
	targetId: "customer",
	reason: "Support correction",
	status: "succeeded" as const,
	details: { amount: 20, reference: "ticket-1" },
};

describe("admin audit log", () => {
	it("is opt-in and exposes no HTTP write endpoint", async () => {
		expect(admin().schema).not.toHaveProperty("adminAuditLog");
		const { auth } = await getTestInstance({ plugins: [admin()] });
		expect(
			(
				await auth.handler(
					new Request("http://localhost:3000/api/auth/admin/audit-logs"),
				)
			).status,
		).toBe(404);
		const enabled = await getTestInstance({
			plugins: [admin({ auditLog: true })],
		});
		expect(
			(
				await enabled.auth.handler(
					new Request("http://localhost:3000/api/auth/admin/audit-logs", {
						method: "POST",
					}),
				)
			).status,
		).not.toBe(200);
	});

	it("deduplicates concurrent identical records and rejects conflicting payloads", async () => {
		const { auth } = await getTestInstance({
			plugins: [admin({ auditLog: true })],
		});
		const { adapter } = await auth.$context;
		const audit = createAdminAuditService(adapter);
		const results = await Promise.all(
			Array.from({ length: 4 }, () => audit.record(input)),
		);
		expect(results.filter((result) => result.applied)).toHaveLength(1);
		expect(new Set(results.map(({ entry }) => entry.id)).size).toBe(1);
		expect(
			(
				await audit.record({
					...input,
					details: { reference: "ticket-1", amount: 20 },
				})
			).applied,
		).toBe(false);
		for (const changed of [
			{ actorId: "other" },
			{ reason: "Different" },
			{ details: { amount: 21 } },
		]) {
			await expect(
				audit.record({ ...input, ...changed }),
			).rejects.toMatchObject({ status: "CONFLICT" });
		}
		await audit.record({ ...input, status: "started" });
		expect(
			(await audit.list({ limit: 10, offset: 0, actorId: "operator" })).entries,
		).toHaveLength(2);
		expect(
			(await audit.list({ limit: 10, offset: 0, targetId: "other" })).entries,
		).toHaveLength(0);
		expect((await audit.list({ limit: 1, offset: 1 })).entries).toHaveLength(1);
		await expect(audit.list({ limit: 101, offset: 0 })).rejects.toBeDefined();
	});

	it("limits indexed operation identifiers to 255 characters before writing", async () => {
		const { auth } = await getTestInstance({
			plugins: [admin({ auditLog: true })],
		});
		const { adapter } = await auth.$context;
		const audit = createAdminAuditService(adapter);
		const create = vi.spyOn(adapter, "create");
		await expect(
			audit.record({ ...input, operationId: "a".repeat(256) }),
		).rejects.toBeDefined();
		expect(create).not.toHaveBeenCalled();
		await expect(
			audit.record({
				...input,
				operationId: "a".repeat(255),
				actorId: "b".repeat(512),
			}),
		).resolves.toMatchObject({ applied: true });
		create.mockRestore();
	});

	it("rejects non-JSON and sensitive details before persistence", async () => {
		const { auth } = await getTestInstance({
			plugins: [admin({ auditLog: true })],
		});
		const { adapter } = await auth.$context;
		const audit = createAdminAuditService(adapter);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		for (const details of [
			{ password: "hidden" },
			{ nested: { accessToken: "hidden" } },
			{ apiKey: "hidden" },
			{ value: Number.NaN },
			{ value: new Date() },
			circular,
		]) {
			await expect(
				audit.record({ ...input, details: details as never }),
			).rejects.toBeDefined();
		}
		expect((await audit.list({ limit: 10, offset: 0 })).entries).toHaveLength(
			0,
		);
	});

	it("propagates storage errors rather than claiming a duplicate succeeded", async () => {
		const { auth } = await getTestInstance({
			plugins: [admin({ auditLog: true })],
		});
		const { adapter } = await auth.$context;
		const create = vi
			.spyOn(adapter, "create")
			.mockRejectedValueOnce(new Error("Unavailable"));
		await expect(
			createAdminAuditService(adapter).record(input),
		).rejects.toThrow("Unavailable");
		create.mockRestore();
	});

	it("uses the caller's transaction adapter without persisting outside a rollback", async () => {
		const { auth } = await getTestInstance(
			{ plugins: [admin({ auditLog: true })] },
			{ transaction: true },
		);
		const { adapter } = await auth.$context;
		await expect(
			adapter.transaction(async (transaction) => {
				await createAdminAuditService(transaction).record(input);
				throw new Error("Rollback");
			}),
		).rejects.toThrow("Rollback");
		expect(
			(await createAdminAuditService(adapter).list({ limit: 20, offset: 0 }))
				.entries,
		).toHaveLength(0);
	});

	it("blocks changes when the initial audit write fails and retains started on an unknown outcome", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [admin({ auditLog: true, defaultRole: "admin" })],
		});
		const { user, headers } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		const originalCreate = adapter.create.bind(adapter);
		const create = vi
			.spyOn(adapter, "create")
			.mockRejectedValueOnce(new Error("Audit unavailable"));
		const request = {
			headers,
			body: { userId: user.id, data: { name: "Updated" } },
		};
		await expect(auth.api.adminUpdateUser(request)).rejects.toThrow(
			"Audit unavailable",
		);
		expect(
			(
				await adapter.findOne<{ name: string }>({
					model: "user",
					where: [{ field: "id", value: user.id }],
				})
			)?.name,
		).toBe(user.name);
		create
			.mockImplementationOnce(originalCreate)
			.mockRejectedValueOnce(new Error("Outcome unavailable"));
		await expect(auth.api.adminUpdateUser(request)).rejects.toThrow(
			"Outcome unavailable",
		);
		create.mockRestore();
		expect(
			(
				await adapter.findOne<{ name: string }>({
					model: "user",
					where: [{ field: "id", value: user.id }],
				})
			)?.name,
		).toBe("Updated");
		expect(
			(
				await createAdminAuditService(adapter).list({ limit: 20, offset: 0 })
			).entries.map(({ status }) => status),
		).toEqual(["started"]);
	});

	it("checks authoritative admin permission even when a cached cookie still says admin", async () => {
		const { auth, signInWithTestUser, client } = await getTestInstance(
			{
				plugins: [admin({ auditLog: true, defaultRole: "admin" })],
				session: { cookieCache: { enabled: true, maxAge: 300 } },
			},
			{ clientOptions: { plugins: [adminClient({ auditLog: true })] } },
		);
		expect(
			(
				await auth.handler(
					new Request("http://localhost:3000/api/auth/admin/audit-logs"),
				)
			).status,
		).toBe(401);
		const { user, headers } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		await createAdminAuditService(adapter).record(input);
		expect(
			(
				await client.admin.auditLogs({
					fetchOptions: { headers, throw: true },
				})
			).entries,
		).toHaveLength(1);
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "user" },
		});
		expect(
			(await client.admin.auditLogs({ fetchOptions: { headers } })).error
				?.status,
		).toBe(403);
	});

	it("records admin changes and API failures without copying credentials", async () => {
		const { auth, signInWithTestUser } = await getTestInstance({
			plugins: [admin({ auditLog: true, defaultRole: "admin" })],
		});
		const { user, headers } = await signInWithTestUser();
		const { adapter } = await auth.$context;
		await auth.api.setUserPassword({
			headers,
			body: { userId: user.id, newPassword: "Secret-password-123" },
		});
		await expect(
			auth.api.banUser({ headers, body: { userId: "missing-user" } }),
		).rejects.toBeDefined();
		const { entries } = await createAdminAuditService(adapter).list({
			limit: 20,
			offset: 0,
		});
		expect(
			entries.filter(
				({ action, status }) =>
					action === "admin.set-user-password" && status === "succeeded",
			),
		).toHaveLength(1);
		expect(
			entries.filter(
				({ action, status }) =>
					action === "admin.ban-user" && status === "failed",
			),
		).toHaveLength(1);
		expect(entries.filter(({ status }) => status === "started")).toHaveLength(
			2,
		);
		expect(JSON.stringify(entries)).not.toContain("Secret-password-123");
	});
});
