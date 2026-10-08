import type { BetterAuthOptions } from "@app/auth-sdk/server";
import nodemailer from "nodemailer";

type Environment = Record<string, string | undefined>;

/** Read server-only mail credentials; local admin setup may run without them. */
export function readEmailConfig(env: Environment = process.env) {
	const host = env.SMTP_HOST?.trim();
	const user = env.SMTP_USER?.trim();
	const password = env.SMTP_PASSWORD;
	const from = env.EMAIL_FROM?.trim();
	if (!host && !user && !password && !from && env.NODE_ENV !== "production")
		return undefined;
	if (!host || !user || !password || !from)
		throw new Error(
			"Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, and EMAIL_FROM to enable email delivery.",
		);
	if (!/^[^\s/:@?#\\]+$/.test(host))
		throw new Error(
			"SMTP_HOST must be a hostname without a URL scheme or port.",
		);
	const portText = env.SMTP_PORT?.trim() || "587";
	const port = Number(portText);
	if (
		!/^\d+$/.test(portText) ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535
	)
		throw new Error("SMTP_PORT must be an integer from 1 to 65535.");
	const secureText = env.SMTP_SECURE?.trim().toLowerCase();
	if (secureText && secureText !== "true" && secureText !== "false")
		throw new Error("SMTP_SECURE must be true or false.");
	const secure = secureText ? secureText === "true" : port === 465;
	if (port === 465 && !secure)
		throw new Error("SMTP_SECURE must be true for port 465.");
	if (
		/[\r\n]/.test(from) ||
		!/^(?:[^<>]+\s<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(from) ||
		from.includes("<") !== from.endsWith(">")
	)
		throw new Error(
			"EMAIL_FROM must be an email address or Name <email@example.com>.",
		);
	return {
		provider: "smtp" as const,
		host,
		port,
		secure,
		user,
		password,
		from,
	};
}

/** Deliver Better Auth verification and reset links through authenticated SMTP. */
export function createEmailHooks(
	config: NonNullable<ReturnType<typeof readEmailConfig>>,
) {
	const transport = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.secure,
		requireTLS: !config.secure,
		auth: { user: config.user, pass: config.password },
		connectionTimeout: 10_000,
		greetingTimeout: 10_000,
		socketTimeout: 15_000,
		dnsTimeout: 10_000,
		disableFileAccess: true,
		disableUrlAccess: true,
		logger: false,
		debug: false,
	});
	async function send(to: string, url: string, purpose: "verify" | "reset") {
		try {
			const link = new URL(url);
			if (
				!["http:", "https:"].includes(link.protocol) ||
				link.username ||
				link.password
			)
				throw new Error("Invalid email action URL.");
			const title =
				purpose === "verify" ? "Verify your email" : "Reset your password";
			const escaped = url
				.replaceAll("&", "&amp;")
				.replaceAll('"', "&quot;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;");
			const result = await transport.sendMail({
				from: config.from,
				to,
				subject: title,
				text: `${title}: ${url}\n\nIf you did not request this email, you can ignore it.`,
				html: `<p><a href="${escaped}">${title}</a></p><p>If you did not request this email, you can ignore it.</p>`,
			});
			if (result.accepted.length === 0 || result.rejected.length !== 0)
				throw new Error("Email delivery failed.");
		} catch {
			// Provider responses can include credentials, addresses, or action tokens.
			throw new Error(
				"Email delivery failed. Check the email provider configuration and retry.",
			);
		}
	}

	return {
		emailVerification: {
			sendOnSignUp: true,
			sendOnSignIn: true,
			sendVerificationEmail: async ({ user, url }) =>
				send(user.email, url, "verify"),
		},
		emailAndPassword: {
			sendResetPassword: async ({ user, url }) =>
				send(user.email, url, "reset"),
		},
	} satisfies {
		emailVerification: NonNullable<BetterAuthOptions["emailVerification"]>;
		emailAndPassword: Pick<
			NonNullable<BetterAuthOptions["emailAndPassword"]>,
			"sendResetPassword"
		>;
	};
}
