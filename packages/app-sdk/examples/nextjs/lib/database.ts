import { Pool } from "pg";
import { requiredEnv } from "./env";

// Next.js 开发环境热更新时复用连接池；此示例使用 Node.js runtime。
const globalForDatabase = globalThis as typeof globalThis & {
	authPool?: Pool;
};

export const database =
	globalForDatabase.authPool ??
	new Pool({ connectionString: requiredEnv("DATABASE_URL") });

if (process.env.NODE_ENV !== "production") {
	globalForDatabase.authPool = database;
}
