import assert from "node:assert/strict";
import test from "node:test";
import { readAdminConfig, readAuthConfig } from "../lib/auth-config.ts";

const local = {
	BETTER_AUTH_SECRET: "test-only-secret-that-is-at-least-32-characters",
	BETTER_AUTH_URL: "http://localhost:3001",
	DASHBOARD_SQLITE_PATH: ".data/test.sqlite",
};

test("requires explicit secure configuration and a single persistent database", () => {
	assert.equal(readAuthConfig(local).database.kind, "sqlite");
	for (const input of [
		{},
		{ ...local, BETTER_AUTH_SECRET: "" },
		{ ...local, BETTER_AUTH_SECRET: "short" },
		{ ...local, BETTER_AUTH_URL: "javascript:alert(1)" },
		{ ...local, BETTER_AUTH_URL: "https://user:password@example.com" },
		{ ...local, BETTER_AUTH_URL: "http://localhost:3001/api/auth" },
		{ ...local, DASHBOARD_SQLITE_PATH: "" },
		{ ...local, DASHBOARD_SQLITE_PATH: ":memory:" },
		{ ...local, DATABASE_URL: "postgresql://localhost/db" },
		{ ...local, NODE_ENV: "production" },
	])
		assert.throws(() => readAuthConfig(input));
	const postgres = readAuthConfig({
		...local,
		NODE_ENV: "production",
		DASHBOARD_SQLITE_PATH: "",
		DATABASE_URL: "postgresql://localhost/dashboard",
	});
	assert.equal(postgres.database.kind, "postgres");
	assert.throws(() =>
		readAuthConfig({
			...local,
			DASHBOARD_SQLITE_PATH: "",
			DATABASE_URL: "mysql://localhost/dashboard",
		}),
	);
});

test("does not disclose connection credentials or initial passwords in validation errors", () => {
	const credential = "private-db-password";
	assert.throws(
		() =>
			readAuthConfig({
				...local,
				DASHBOARD_SQLITE_PATH: "",
				DATABASE_URL: `mysql://user:${credential}@localhost/db`,
			}),
		(error) => error instanceof Error && !error.message.includes(credential),
	);
	assert.throws(
		() =>
			readAdminConfig({
				DASHBOARD_ADMIN_EMAIL: "admin@example.com",
				DASHBOARD_ADMIN_PASSWORD: "private",
			}),
		/12–128/,
	);
	assert.throws(() =>
		readAdminConfig({
			DASHBOARD_ADMIN_EMAIL: "invalid",
			DASHBOARD_ADMIN_PASSWORD: "a-long-test-password",
		}),
	);
	assert.deepEqual(
		readAdminConfig({
			DASHBOARD_ADMIN_EMAIL: " Admin@Example.com ",
			DASHBOARD_ADMIN_PASSWORD: "a-long-test-password",
		}),
		{
			email: "admin@example.com",
			password: "a-long-test-password",
			name: "Administrator",
		},
	);
});
