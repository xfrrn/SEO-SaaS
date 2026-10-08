import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const run = process.env.DASHBOARD_E2E_RUN ?? randomUUID();
const port = Number(process.env.DASHBOARD_E2E_PORT ?? 3047);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
	throw new Error("DASHBOARD_E2E_PORT must be a valid local port.");
const directory = resolve(__dirname, ".cache", `e2e-${run}`);
mkdirSync(directory, { recursive: true });
// Never read developer database or administrator credentials for browser tests.
const environment = {
	DASHBOARD_E2E_RUN: run,
	DASHBOARD_E2E_DIRECTORY: directory,
	DASHBOARD_E2E_PASSWORD:
		process.env.DASHBOARD_E2E_PASSWORD ?? randomBytes(24).toString("hex"),
	BETTER_AUTH_SECRET:
		process.env.DASHBOARD_E2E_SECRET ?? randomBytes(32).toString("hex"),
	BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
	DASHBOARD_SQLITE_PATH: resolve(directory, "dashboard.sqlite"),
	DATABASE_URL: "",
	NODE_ENV: "development",
	NEXT_TELEMETRY_DISABLED: "1",
	NO_PROXY: `${process.env.NO_PROXY ?? ""},127.0.0.1,localhost`,
};
Object.assign(process.env, environment, {
	DASHBOARD_E2E_SECRET: environment.BETTER_AUTH_SECRET,
});

export default defineConfig({
	testDir: "./test",
	testMatch: "dashboard.spec.ts",
	globalSetup: "./test/e2e-setup.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	outputDir: resolve(directory, "results"),
	reporter: "list",
	use: {
		baseURL: environment.BETTER_AUTH_URL,
		actionTimeout: 15_000,
		channel: process.env.DASHBOARD_E2E_BROWSER,
		viewport: { width: 1440, height: 1000 },
		colorScheme: "light",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: `pnpm --config.verify-deps-before-run=false exec next dev --turbopack --hostname 127.0.0.1 --port ${port}`,
		url: environment.BETTER_AUTH_URL,
		env: environment,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
