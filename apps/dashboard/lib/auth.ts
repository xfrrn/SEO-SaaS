import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { business } from "@app/auth-sdk/business";
import { credits } from "@app/auth-sdk/credits";
import { nextCookies } from "@app/auth-sdk/next-js";
import { admin } from "@app/auth-sdk/plugins";
import { betterAuth } from "@app/auth-sdk/server";
import { subscription } from "@app/auth-sdk/subscription";
import Database from "better-sqlite3";
import { Pool } from "pg";
import { readAuthConfig } from "./auth-config.ts";

function createAuth() {
	const config = readAuthConfig();
	let database: Pool | Database.Database;
	if (config.database.kind === "postgres") {
		const pool = new Pool({
			connectionString: config.database.connectionString,
			connectionTimeoutMillis: 10_000,
		});
		pool.on("error", () => {
			console.error("[dashboard-auth] An idle PostgreSQL connection failed.");
		});
		database = pool;
		closeDatabase = () => pool.end();
	} else {
		const path = resolve(config.database.path);
		mkdirSync(dirname(path), { recursive: true });
		const sqlite = new Database(path);
		database = sqlite;
		sqlite.pragma("journal_mode = WAL");
		sqlite.pragma("foreign_keys = ON");
		closeDatabase = () => {
			sqlite.close();
		};
	}
	return betterAuth({
		appName: "Dashboard",
		database,
		secret: config.secret,
		baseURL: config.baseURL,
		basePath: "/api/auth",
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			minPasswordLength: 12,
		},
		plugins: [
			admin({ auditLog: true }),
			subscription({ catalog: true }),
			credits(),
			business({ providers: {} }),
			nextCookies(),
		],
	});
}

let auth: ReturnType<typeof createAuth> | undefined;
let closeDatabase: (() => void | Promise<void>) | undefined;

/** Create the real SDK server on first use; never migrate or seed during a request. */
export function getAuth() {
	return (auth ??= createAuth());
}

/** Release the setup CLI's database resources so it can terminate cleanly. */
export async function closeAuth() {
	await closeDatabase?.();
	closeDatabase = undefined;
	auth = undefined;
}
