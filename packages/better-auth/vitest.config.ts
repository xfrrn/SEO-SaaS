import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		fsModuleCache: true,
		injectCjsGlobals: false,
		testTimeout: 10_000,
		execArgv: ["--expose-gc"],
		exclude: ["**/node_modules/**", "**/dist/**"],
	},
});
