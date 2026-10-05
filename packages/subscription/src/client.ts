import type { BetterAuthClientPlugin } from "better-auth/client";
import type { subscription } from "./index";

/** Add authenticated plan and subscription reads to a Better Auth client. */
export function subscriptionClient() {
	return {
		id: "subscription-client",
		$InferServerPlugin: {} as ReturnType<typeof subscription>,
	} satisfies BetterAuthClientPlugin;
}
