import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { GET, POST } from "../app/api/auth/[...all]/route.ts";
import { closeAuth, getAuth } from "../lib/auth.ts";

test("Google callbacks bind existing admins, create ordinary users and enforce account ownership", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "dashboard-google-"));
	const database = join(directory, "auth.sqlite");
	const environment = {
		NODE_ENV: "test",
		BETTER_AUTH_URL: "http://127.0.0.1:3001",
		BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
		DATABASE_URL: "",
		DASHBOARD_SQLITE_PATH: database,
		GOOGLE_CLIENT_ID: "dashboard-test.apps.googleusercontent.com",
		GOOGLE_CLIENT_SECRET: "test-server-only-google-secret",
		PAYMENT_PROVIDER: "none",
		APP_MONITOR_ENABLED: "false",
		SMTP_HOST: "",
		SMTP_USER: "",
		SMTP_PASSWORD: "",
		EMAIL_FROM: "",
	};
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, environment);
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const now = Math.floor(Date.now() / 1000);
	let profile = {
		sub: "google-admin",
		email: "admin@google-test.example",
		email_verified: true,
		name: "Google administrator",
	};
	function idToken(audience = environment.GOOGLE_CLIENT_ID) {
		const header = { alg: "RS256", kid: "test-google-key" };
		const payload = {
			...profile,
			iss: "https://accounts.google.com",
			aud: audience,
			iat: now,
			exp: now + 3600,
		};
		const input = [header, payload]
			.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
			.join(".");
		return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
	}
	context.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === "https://oauth2.googleapis.com/token")
				return Response.json({
					access_token: "test-google-access-token",
					id_token: idToken(),
					token_type: "Bearer",
					expires_in: 3600,
				});
			assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
			return Response.json({
				keys: [
					{
						...publicKey.export({ format: "jwk" }),
						kid: "test-google-key",
						alg: "RS256",
						use: "sig",
					},
				],
			});
		},
	);
	const origin = environment.BETTER_AUTH_URL;
	function cookies(response: Response) {
		return response.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
	}
	function post(path: string, body: Record<string, unknown>, cookie = "") {
		return POST(
			new Request(`${origin}/api/auth${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin, cookie },
				body: JSON.stringify(body),
			}),
		);
	}
	async function start(path = "/sign-in/social", cookie = "") {
		const response = await post(
			path,
			{ provider: "google", callbackURL: "/", errorCallbackURL: "/" },
			cookie,
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(
			JSON.stringify(body).includes(environment.GOOGLE_CLIENT_SECRET),
			false,
		);
		const url = new URL(body.url);
		assert.equal(
			url.searchParams.get("redirect_uri"),
			`${origin}/api/auth/callback/google`,
		);
		assert.equal(url.searchParams.get("prompt"), "select_account");
		assert.equal(url.searchParams.get("code_challenge_method"), "S256");
		return {
			url,
			cookie: [cookie, cookies(response)].filter(Boolean).join("; "),
		};
	}
	function callback(
		flow: Awaited<ReturnType<typeof start>>,
		query: Record<string, string> = { code: "test-code" },
	) {
		const url = new URL(`${origin}/api/auth/callback/google`);
		url.searchParams.set("state", flow.url.searchParams.get("state")!);
		for (const [key, value] of Object.entries(query))
			url.searchParams.set(key, value);
		return GET(new Request(url, { headers: { cookie: flow.cookie } }));
	}
	try {
		const auth = getAuth();
		await (await getMigrations(auth.options)).runMigrations();
		const { adapter } = await auth.$context;
		const password = randomUUID() + randomUUID();
		const { user: admin } = await auth.api.createUser({
			body: { name: "Admin", email: profile.email, password, role: "admin" },
		});
		assert.equal(admin.emailVerified, false);
		const unlinked = await callback(await start());
		assert.equal(
			new URL(unlinked.headers.get("location")!, origin).searchParams.get(
				"error",
			),
			"account_not_linked",
		);
		assert.equal(
			await adapter.count({
				model: "account",
				where: [{ field: "providerId", value: "google" }],
			}),
			0,
		);

		const signed = await post("/sign-in/email", {
			email: admin.email,
			password,
		});
		assert.equal(signed.status, 200);
		const adminCookie = cookies(signed);
		const link = await callback(await start("/link-social", adminCookie));
		assert.equal(link.status, 302);
		assert.equal(link.headers.get("location"), "/");
		const login = await callback(await start());
		assert.equal(login.status, 302);
		const session = await auth.api.getSession({
			headers: new Headers({ cookie: cookies(login) }),
		});
		assert.equal(session?.user.id, admin.id);
		assert.equal(session?.user.role, "admin");
		assert.equal(await adapter.count({ model: "user" }), 1);

		profile = {
			...profile,
			sub: "google-customer",
			email: "customer@google-test.example",
		};
		const mismatch = await callback(await start("/link-social", adminCookie));
		assert.equal(
			new URL(mismatch.headers.get("location")!, origin).searchParams.get(
				"error",
			),
			"email_does_not_match",
		);
		const customer = await callback(await start());
		const customerCookie = cookies(customer);
		const ordinary = await auth.api.getSession({
			headers: new Headers({ cookie: customerCookie }),
		});
		assert.equal(ordinary?.user.role, "user");
		assert.equal(ordinary?.user.emailVerified, true);
		const denied = await GET(
			new Request(`${origin}/api/auth/business/admin/overview`, {
				headers: { cookie: customerCookie },
			}),
		);
		assert.equal(denied.status, 403);
		assert.equal(await adapter.count({ model: "user" }), 2);
		profile = { ...profile, email: admin.email };
		const owned = await callback(await start("/link-social", adminCookie));
		assert.equal(
			new URL(owned.headers.get("location")!, origin).searchParams.get("error"),
			"account_already_linked_to_different_user",
		);
		const badAudience = await post("/sign-in/social", {
			provider: "google",
			idToken: { token: idToken("another-site") },
		});
		assert.equal(badAudience.status, 401);
		const cancelled = await callback(await start(), { error: "access_denied" });
		assert.equal(
			new URL(cancelled.headers.get("location")!, origin).searchParams.get(
				"error",
			),
			"access_denied",
		);
	} finally {
		await closeAuth();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const suffix of ["", "-wal", "-shm"])
			await rm(database + suffix, { force: true });
		await rmdir(directory);
	}
});
