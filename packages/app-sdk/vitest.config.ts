import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./examples/nextjs", import.meta.url)),
		},
	},
	test: {
		clearMocks: true,
		restoreMocks: true,
		testTimeout: 10_000,
	},
});
