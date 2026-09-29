import { createAuthClient } from "@app/auth-sdk/react";
import { stripeClient } from "@app/auth-sdk/stripe/client";

// 将此文件复制到 lib/auth-client.ts，保持服务端与客户端插件成对启用。
export const authClient = createAuthClient({
	plugins: [stripeClient({ subscription: true })],
});
