import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GET, POST } from "../app/api/auth/[...all]/route.ts";
import { closeAuth, getAuth } from "../lib/auth.ts";

test("real setup migrates once, never rewrites existing users, and keeps signup closed", async () => {
	const directory = fileURLToPath(new URL("..", import.meta.url));
	const database = resolve(directory, ".data/setup-check.sqlite");
	assert.equal(
		existsSync(database),
		false,
		"Refusing to reuse an existing setup-check.sqlite file.",
	);
	const secret = randomUUID() + randomUUID();
	const password = randomUUID() + randomUUID();
	const replacement = randomUUID() + randomUUID();
	const environment = {
		NODE_ENV: "test" as const,
		DATABASE_URL: "",
		DASHBOARD_SQLITE_PATH: database,
		BETTER_AUTH_URL: "http://127.0.0.1:3001",
		BETTER_AUTH_SECRET: secret,
		DASHBOARD_ADMIN_EMAIL: `bootstrap-${randomUUID()}@example.test`,
		DASHBOARD_ADMIN_PASSWORD: password,
		DASHBOARD_ADMIN_NAME: "Setup check administrator",
	};
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, environment);
	function setup(overrides: Record<string, string> = {}) {
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", "scripts/setup.ts"],
			{
				cwd: directory,
				env: { ...process.env, ...environment, ...overrides },
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		const output = result.stdout + result.stderr;
		for (const credential of [secret, password, replacement]) {
			assert.equal(
				output.includes(credential),
				false,
				"Setup must never print credentials.",
			);
		}
		return { status: result.status, output };
	}
	try {
		const first = setup();
		assert.equal(first.status, 0, first.output);
		assert.match(first.output, /Initial administrator created/);
		const repeated = setup({
			DASHBOARD_ADMIN_PASSWORD: replacement,
			DASHBOARD_ADMIN_NAME: "Must not replace name",
		});
		assert.equal(repeated.status, 1);
		assert.match(repeated.output, /No password or role was changed/);
		const auth = getAuth();
		const { adapter } = await auth.$context;
		const signed = await auth.api.signInEmail({
			body: { email: environment.DASHBOARD_ADMIN_EMAIL, password },
		});
		assert.equal(signed.user.role, "admin");
		assert.equal(signed.user.name, environment.DASHBOARD_ADMIN_NAME);
		assert.equal(await adapter.count({ model: "user" }), 1);
		assert.equal(await adapter.count({ model: "adminAuditLog" }), 1);
		await assert.rejects(
			auth.api.signInEmail({
				body: {
					email: environment.DASHBOARD_ADMIN_EMAIL,
					password: replacement,
				},
			}),
		);

		const { user } = await auth.api.createUser({
			body: {
				email: `ordinary-${randomUUID()}@example.test`,
				name: "Ordinary user",
				password,
				role: "user",
			},
		});
		const ordinary = setup({ DASHBOARD_ADMIN_EMAIL: user.email });
		assert.equal(ordinary.status, 1);
		const unchanged = await adapter.findOne<{ role: string }>({
			model: "user",
			where: [{ field: "id", value: user.id }],
		});
		assert.equal(unchanged?.role, "user");

		const signup = await POST(
			new Request(`${environment.BETTER_AUTH_URL}/api/auth/sign-up/email`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: environment.BETTER_AUTH_URL,
				},
				body: JSON.stringify({
					email: "public-signup@example.test",
					password,
					name: "Public",
				}),
			}),
		);
		assert.equal(signup.status, 400);
		const signupBody: unknown = await signup.json();
		assert.ok(
			signupBody &&
				typeof signupBody === "object" &&
				"code" in signupBody &&
				signupBody.code === "EMAIL_PASSWORD_SIGN_UP_DISABLED",
		);
		assert.equal(await adapter.count({ model: "user" }), 2);
		await closeAuth();
		delete process.env.BETTER_AUTH_SECRET;
		const unavailable = await GET(
			new Request(`${environment.BETTER_AUTH_URL}/api/auth/get-session`),
		);
		assert.equal(unavailable.status, 503);
		const message = await unavailable.text();
		assert.match(message, /DASHBOARD_UNAVAILABLE/);
		assert.equal(message.includes(secret), false);
		assert.equal(message.includes(password), false);
	} finally {
		await closeAuth();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const suffix of ["", "-wal", "-shm"])
			await rm(database + suffix, { force: true });
	}
});
