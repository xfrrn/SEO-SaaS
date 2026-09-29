import { nextCookies } from "@app/auth-sdk/next-js";
import { betterAuth } from "@app/auth-sdk/server";
import { database } from "./database";
import { requiredEnv } from "./env";

// 仅在服务端导入；浏览器组件使用 auth-client.ts。
export const auth = betterAuth({
	secret: requiredEnv("BETTER_AUTH_SECRET"),
	baseURL: requiredEnv("BETTER_AUTH_URL"),
	database,
	emailAndPassword: { enabled: true },
	plugins: [nextCookies()], // nextCookies 始终放在最后。
});
