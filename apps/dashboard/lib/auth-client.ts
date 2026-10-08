"use client";

import { businessClient } from "@app/auth-sdk/business/client";
import { adminClient } from "@app/auth-sdk/client/plugins";
import { createAuthClient } from "@app/auth-sdk/react";

export const authClient = createAuthClient({
	plugins: [adminClient({ auditLog: true }), businessClient()],
});
