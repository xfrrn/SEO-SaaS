import type { BetterAuthClientPlugin } from "better-auth/client";
import type { credits } from "./index";

/** Add authenticated balance and ledger reads; grants and debits stay server-only. */
export function creditsClient() {
	return {
		id: "credits-client",
		$InferServerPlugin: {} as ReturnType<typeof credits>,
	} satisfies BetterAuthClientPlugin;
}
