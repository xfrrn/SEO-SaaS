import { tickets } from "@app/auth-sdk/tickets";
import { ticketsClient } from "@app/auth-sdk/tickets/client";
import { admin } from "better-auth/plugins/admin";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it, vi } from "vitest";

async function setup() {
	const instance = await getTestInstance(
		{
			plugins: [admin({ auditLog: true }), tickets()],
			session: { cookieCache: { enabled: true } },
			advanced: { disableOriginCheck: false },
		},
		{ transaction: true, clientOptions: { plugins: [ticketsClient()] } },
	);
	const { headers, user } = await instance.signInWithTestUser();
	headers.set("origin", "http://localhost:3000");
	const { adapter } = await instance.auth.$context;
	const options = { headers, throw: true as const };
	const create = (key = crypto.randomUUID()) =>
		instance.client.tickets.create({
			title: "账户问题",
			content: "请帮我查看此问题。",
			idempotencyKey: key,
			fetchOptions: options,
		});
	const promote = () =>
		adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "admin" },
		});
	return { ...instance, adapter, headers, user, options, create, promote };
}

describe("support tickets", () => {
	it("creates, pages and replays a user's feedback without trusting supplied ownership", async () => {
		const { client, create, options, adapter, auth } = await setup();
		const key = crypto.randomUUID();
		const { ticket } = await create(key);
		expect((await create(key)).ticket.id).toBe(ticket.id);
		expect(await adapter.count({ model: "supportTicket" })).toBe(1);
		expect(ticket.status).toBe("open");
		expect(
			(
				await client.tickets.list({
					query: { limit: 1, offset: 0 },
					fetchOptions: options,
				})
			).tickets[0]?.id,
		).toBe(ticket.id);
		const conflict = await client.tickets.create({
			title: "Different",
			content: "Different",
			idempotencyKey: key,
			fetchOptions: { headers: options.headers },
		});
		expect(conflict.error?.status).toBe(409);
		const forged = await client.$fetch("/tickets/create", {
			method: "POST",
			headers: options.headers,
			body: {
				title: "forged",
				content: "test",
				userId: "victim",
				status: "closed",
				idempotencyKey: crypto.randomUUID(),
			},
		});
		expect(forged.error?.status).toBe(400);
		const invalid = await client.tickets.create({
			title: " ",
			content: "x".repeat(10_001),
			idempotencyKey: crypto.randomUUID(),
			fetchOptions: { headers: options.headers },
		});
		expect(invalid.error?.status).toBe(400);
		const dateText = "2026-10-17T00:00:00.000Z";
		const dated = await client.tickets.create({
			title: dateText,
			content: dateText,
			idempotencyKey: crypto.randomUUID(),
			fetchOptions: options,
		});
		expect(dated.ticket.title).toBe(dateText);
		expect(dated.ticket.content).toBe(dateText);
		expect(dated.ticket.createdAt).toBeInstanceOf(Date);
		const wrongOrigin = new Headers(options.headers);
		wrongOrigin.set("origin", "https://untrusted.example");
		expect(
			(
				await client.tickets.reply({
					ticketId: ticket.id,
					content: "forged origin",
					idempotencyKey: crypto.randomUUID(),
					fetchOptions: { headers: wrongOrigin },
				})
			).error?.status,
		).toBe(403);
		const response = await auth.handler(
			new Request("http://localhost:3000/api/auth/tickets/list"),
		);
		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("isolates owners, rejects anonymous callers and requires fresh administrator permissions", async () => {
		const { client, create, options, auth, adapter, user, promote } =
			await setup();
		const { ticket } = await create();
		const other = await client.signUp.email({
			email: "other@tickets.example",
			password: "test-password-123",
			name: "Other",
		});
		expect(other.error).toBeNull();
		const cookie = new Headers();
		cookie.set("origin", "http://localhost:3000");
		await client.signIn.email(
			{ email: "other@tickets.example", password: "test-password-123" },
			{
				onSuccess: ({ response }) => {
					cookie.set(
						"cookie",
						response.headers
							.getSetCookie()
							.map((value) => value.split(";")[0])
							.join("; "),
					);
				},
			},
		);
		expect(
			(
				await client.tickets.get({
					query: { ticketId: ticket.id },
					fetchOptions: { headers: cookie },
				})
			).error?.status,
		).toBe(404);
		expect(
			(
				await client.tickets.reply({
					ticketId: ticket.id,
					content: "unauthorized",
					idempotencyKey: crypto.randomUUID(),
					fetchOptions: { headers: cookie },
				})
			).error?.status,
		).toBe(404);
		expect(
			(
				await client.tickets.list({
					query: {},
					fetchOptions: { headers: cookie },
				})
			).data?.total,
		).toBe(0);
		expect((await client.tickets.list({ query: {} })).error?.status).toBe(401);
		expect(
			(
				await client.tickets.admin.list({
					query: {},
					fetchOptions: { headers: options.headers },
				})
			).error?.status,
		).toBe(403);
		await promote();
		expect(
			(await client.tickets.admin.list({ query: {}, fetchOptions: options }))
				.total,
		).toBe(1);
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { role: "user" },
		});
		expect(
			(
				await client.tickets.admin.get({
					query: { ticketId: ticket.id },
					fetchOptions: { headers: options.headers },
				})
			).error?.status,
		).toBe(403);
		await adapter.update({
			model: "user",
			where: [{ field: "id", value: user.id }],
			update: { banned: true },
		});
		expect(
			(
				await client.tickets.list({
					query: {},
					fetchOptions: { headers: options.headers },
				})
			).error?.status,
		).toBe(403);
		expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
	});

	it("appends replies and status history once, rejects stale changes and preserves closed tickets", async () => {
		const { client, create, options, promote, adapter } = await setup();
		const { ticket } = await create();
		const message = {
			ticketId: ticket.id,
			content: "<script>alert('plain text')</script>",
			idempotencyKey: crypto.randomUUID(),
			fetchOptions: options,
		};
		await client.tickets.reply(message);
		await client.tickets.reply(message);
		await promote();
		await client.tickets.admin.reply({
			...message,
			content: "我们正在处理。",
			idempotencyKey: crypto.randomUUID(),
		});
		const update = {
			ticketId: ticket.id,
			status: "closed" as const,
			expectedRevision: 2,
			idempotencyKey: crypto.randomUUID(),
			fetchOptions: options,
		};
		await client.tickets.admin.status(update);
		await client.tickets.admin.status(update);
		const current = await client.tickets.get({
			query: { ticketId: ticket.id, limit: 2, offset: 0 },
			fetchOptions: options,
		});
		expect(current.ticket.status).toBe("closed");
		expect(current.total).toBe(3);
		expect(current.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
		expect(current.entries[0]?.content).toBe(message.content);
		expect(
			(
				await client.tickets.get({
					query: { ticketId: ticket.id, offset: 2 },
					fetchOptions: options,
				})
			).entries[0]?.kind,
		).toBe("status");
		expect(
			(
				await client.tickets.reply({
					...message,
					idempotencyKey: crypto.randomUUID(),
					fetchOptions: { headers: options.headers },
				})
			).error?.code,
		).toBe("TICKET_CLOSED");
		expect(
			(
				await client.tickets.admin.status({
					...update,
					status: "open",
					idempotencyKey: crypto.randomUUID(),
					fetchOptions: { headers: options.headers },
				})
			).error?.status,
		).toBe(409);
		await client.tickets.admin.status({
			...update,
			status: "open",
			expectedRevision: 3,
			idempotencyKey: crypto.randomUUID(),
		});
		await client.tickets.reply({
			...message,
			idempotencyKey: crypto.randomUUID(),
		});
		expect(await adapter.count({ model: "supportTicketEntry" })).toBe(5);
		expect(await adapter.count({ model: "adminAuditLog" })).toBe(3);
	});

	it("rolls back the reply and revision when its audit cannot be saved", async () => {
		const { client, create, options, promote, adapter } = await setup();
		const { ticket } = await create();
		await promote();
		const original = adapter.transaction.bind(adapter);
		const failure = vi
			.spyOn(adapter, "transaction")
			.mockImplementation((callback) =>
				original(async (db) => {
					const createRow = db.create.bind(db);
					db.create = async (input) => {
						if (input.model === "adminAuditLog")
							throw new Error("test audit failure");
						return createRow(input);
					};
					return callback(db);
				}),
			);
		const result = await client.tickets.admin.reply({
			ticketId: ticket.id,
			content: "must roll back",
			idempotencyKey: crypto.randomUUID(),
			fetchOptions: { headers: options.headers },
		});
		expect(result.error?.status).toBe(500);
		failure.mockRestore();
		expect(await adapter.count({ model: "supportTicketEntry" })).toBe(0);
		expect(
			(
				await client.tickets.get({
					query: { ticketId: ticket.id },
					fetchOptions: options,
				})
			).ticket.revision,
		).toBe(0);
	});

	it("rejects impersonated sessions for both customer and administrator operations", async () => {
		const { auth, client, options, promote, adapter } = await setup();
		await promote();
		const session = await auth.api.getSession({ headers: options.headers });
		expect(session).not.toBeNull();
		await adapter.update({
			model: "session",
			where: [{ field: "id", value: session!.session.id }],
			update: { impersonatedBy: "test-administrator" },
		});
		expect(
			(
				await client.tickets.list({
					query: {},
					fetchOptions: { headers: options.headers },
				})
			).error?.status,
		).toBe(403);
		expect(
			(
				await client.tickets.admin.list({
					query: {},
					fetchOptions: { headers: options.headers },
				})
			).error?.status,
		).toBe(403);
	});
});
