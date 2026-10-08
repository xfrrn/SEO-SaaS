import assert from "node:assert/strict";
import test from "node:test";
import { betterAuth } from "@app/auth-sdk/server";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import type { SendMailOptions } from "nodemailer";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { createEmailHooks, readEmailConfig } from "../lib/email.ts";

const configured = {
	SMTP_HOST: "smtp.example.test",
	SMTP_USER: "account@example.test",
	SMTP_PASSWORD: "test-private-smtp-password",
	EMAIL_FROM: "Website <account@example.test>",
};

const accepted: SMTPTransport.SentMessageInfo = {
	accepted: ["user@example.test"],
	rejected: [],
	pending: [],
	envelopeTime: 0,
	messageTime: 0,
	messageSize: 0,
	response: "250 OK",
	messageId: "test-mail",
	envelope: { from: "account@example.test", to: ["user@example.test"] },
};

test("mail config is mandatory in production and rejects partial or malformed settings without exposing secrets", () => {
	assert.equal(readEmailConfig({}), undefined);
	assert.deepEqual(readEmailConfig(configured), {
		provider: "smtp",
		host: configured.SMTP_HOST,
		port: 587,
		secure: false,
		user: configured.SMTP_USER,
		password: configured.SMTP_PASSWORD,
		from: configured.EMAIL_FROM,
	});
	assert.equal(
		readEmailConfig({ ...configured, SMTP_PORT: "465" })!.secure,
		true,
	);
	for (const input of [
		{ NODE_ENV: "production" },
		{ SMTP_PASSWORD: configured.SMTP_PASSWORD },
		{ EMAIL_FROM: configured.EMAIL_FROM },
		{ ...configured, SMTP_HOST: "smtp://smtp.example.test" },
		{ ...configured, SMTP_PORT: "1e3" },
		{ ...configured, SMTP_PORT: "0" },
		{ ...configured, SMTP_PORT: "65536" },
		{ ...configured, SMTP_PORT: "465", SMTP_SECURE: "false" },
		{ ...configured, SMTP_SECURE: "yes" },
		{ ...configured, EMAIL_FROM: "invalid" },
		{ ...configured, EMAIL_FROM: "<account@example.test" },
		{ ...configured, EMAIL_FROM: "account@example.test>" },
		{
			...configured,
			EMAIL_FROM: "account@example.test\r\nBcc: other@example.test",
		},
	])
		assert.throws(
			() => readEmailConfig(input),
			(error) =>
				error instanceof Error &&
				!error.message.includes(configured.SMTP_PASSWORD),
		);
});

test("verification and reset emails escape links and never disclose provider failures", async (context) => {
	const emails: SendMailOptions[] = [];
	const transport = nodemailer.createTransport({ host: configured.SMTP_HOST });
	const factory = context.mock.method(
		nodemailer,
		"createTransport",
		(_options: SMTPTransport.Options) => transport,
	);
	const sendMock = context.mock.method(
		transport,
		"sendMail",
		async (mail: SendMailOptions) => {
			emails.push(mail);
			return accepted;
		},
	);
	const hooks = createEmailHooks(readEmailConfig(configured)!);
	const options = factory.mock.calls[0]!.arguments[0] as SMTPTransport.Options;
	assert.equal(options.host, configured.SMTP_HOST);
	assert.equal(options.port, 587);
	assert.equal(options.secure, false);
	assert.equal(options.requireTLS, true);
	assert.deepEqual(options.auth, {
		user: configured.SMTP_USER,
		pass: configured.SMTP_PASSWORD,
	});
	assert.equal(options.connectionTimeout, 10_000);
	assert.equal(options.socketTimeout, 15_000);
	assert.equal(options.disableFileAccess, true);
	assert.equal(options.disableUrlAccess, true);
	assert.equal(options.logger, false);
	assert.equal(options.debug, false);
	const data = {
		user: {
			id: "user-id",
			name: "User",
			email: "user@example.test",
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		url: 'https://example.test/api/auth/verify-email?token=private-token&callbackURL="<test>"',
		token: "private-token",
	};
	await hooks.emailVerification.sendVerificationEmail(data);
	await hooks.emailAndPassword.sendResetPassword(data);
	assert.equal(emails.length, 2);
	const payload = emails[0]!;
	assert.equal(payload.from, configured.EMAIL_FROM);
	assert.equal(payload.to, data.user.email);
	assert.ok(typeof payload.html === "string");
	assert.ok(typeof payload.text === "string");
	assert.match(payload.html, /&amp;callbackURL=&quot;&lt;test&gt;&quot;/);
	assert.equal(payload.html.includes("<test>"), false);
	assert.ok(payload.text.includes(data.url));
	assert.equal(emails[1]!.subject, "Reset your password");
	await assert.rejects(
		hooks.emailVerification.sendVerificationEmail({
			...data,
			url: "javascript:alert(1)",
		}),
	);
	await assert.rejects(
		hooks.emailVerification.sendVerificationEmail({
			...data,
			url: "private-token",
		}),
		(error) =>
			error instanceof Error &&
			!error.message.includes("private-token") &&
			!("input" in error),
	);
	assert.equal(emails.length, 2);
	for (const outcome of [
		() => ({ ...accepted, accepted: [], rejected: [data.user.email] }),
		() => {
			throw new Error(`${configured.SMTP_PASSWORD} private-token`);
		},
	]) {
		sendMock.mock.mockImplementation(async () => outcome());
		await assert.rejects(
			hooks.emailVerification.sendVerificationEmail(data),
			(error) =>
				error instanceof Error &&
				/Email delivery failed/.test(error.message) &&
				!error.message.includes("private"),
		);
	}
});

test("email signup requires verification, then supports password recovery with real auth endpoints", async (context) => {
	const emails: { text: string; subject: string }[] = [];
	const transport = nodemailer.createTransport({ host: configured.SMTP_HOST });
	context.mock.method(nodemailer, "createTransport", () => transport);
	context.mock.method(transport, "sendMail", async (mail: SendMailOptions) => {
		assert.ok(
			typeof mail.text === "string" && typeof mail.subject === "string",
		);
		emails.push({ text: mail.text, subject: mail.subject });
		return accepted;
	});
	const database = new Database(":memory:");
	const hooks = createEmailHooks(readEmailConfig(configured)!);
	const auth = betterAuth({
		database,
		secret: "email-test-only-secret-at-least-32-characters",
		baseURL: "http://localhost:3001",
		logger: { disabled: true },
		emailVerification: hooks.emailVerification,
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 12,
			requireEmailVerification: true,
			revokeSessionsOnPasswordReset: true,
			...hooks.emailAndPassword,
		},
	});
	try {
		await (await getMigrations(auth.options)).runMigrations();
		const body = {
			name: "New user",
			email: "new-user@example.test",
			password: "initial-test-password",
		};
		const signup = await auth.api.signUpEmail({ body });
		assert.equal(signup.token, null);
		assert.equal(signup.user.emailVerified, false);
		assert.equal(emails.length, 1);
		assert.equal(emails[0]!.subject, "Verify your email");
		await assert.rejects(auth.api.signInEmail({ body }));
		assert.equal(emails.length, 2);
		const verificationURL = new URL(
			emails[0]!.text.split("\n")[0]!.replace("Verify your email: ", ""),
		);
		await auth.api.verifyEmail({
			query: { token: verificationURL.searchParams.get("token")! },
		});
		const signed = await auth.api.signInEmail({ body });
		assert.equal(signed.user.emailVerified, true);
		assert.ok(signed.token);
		await auth.api.requestPasswordReset({
			body: {
				email: body.email,
				redirectTo: "http://localhost:3001/reset-password",
			},
		});
		const resetEmail = emails.at(-1)!;
		assert.equal(resetEmail.subject, "Reset your password");
		const resetURL = new URL(
			resetEmail.text.split("\n")[0]!.replace("Reset your password: ", ""),
		);
		const token = resetURL.pathname.split("/").at(-1)!;
		const newPassword = "replacement-test-password";
		await auth.api.resetPassword({ body: { token, newPassword } });
		await assert.rejects(auth.api.signInEmail({ body }));
		assert.ok(
			(
				await auth.api.signInEmail({
					body: { email: body.email, password: newPassword },
				})
			).token,
		);
		const { adapter } = await auth.$context;
		assert.equal(
			await adapter.count({
				model: "session",
				where: [{ field: "token", value: signed.token }],
			}),
			0,
		);
	} finally {
		database.close();
	}
});
