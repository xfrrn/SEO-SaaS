import type { BetterAuthClientPlugin } from "better-auth/client";
import type { generation } from "./index";

/** Typed generation methods; credentials and worker operations remain server-only. */
export function generationClient() {
	return {
		id: "generation-client",
		$InferServerPlugin: {} as ReturnType<typeof generation>,
		pathMethods: {
			"/generation/models": "GET",
			"/generation/get": "GET",
			"/generation/list": "GET",
		},
	} satisfies BetterAuthClientPlugin;
}
