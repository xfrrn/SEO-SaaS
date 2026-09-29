import { defineConfig } from "tsdown";

export default defineConfig({
	dts: { build: true, incremental: true },
	format: ["esm"],
	entry: [
		"./src/server.ts",
		"./src/react.ts",
		"./src/next-js.ts",
		"./src/plugins.ts",
		"./src/client/plugins.ts",
		"./src/stripe.ts",
		"./src/stripe/client.ts",
	],
	treeshake: true,
});
