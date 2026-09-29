import { createAuthClient } from "@app/auth-sdk/react";

// 默认请求当前网站的 /api/auth，无需暴露任何服务端环境变量。
export const authClient = createAuthClient();
