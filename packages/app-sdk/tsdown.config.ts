import { defineConfig } from "tsdown";

export default defineConfig({
	dts: { build: true, incremental: true },
	format: ["esm"],
	entry: [
		"./src/business.ts",
		"./src/business/client.ts",
		"./src/metrics.ts",
		"./src/credits.ts",
		"./src/credits/client.ts",
		"./src/subscription.ts",
		"./src/subscription/client.ts",
		"./src/server.ts",
		"./src/react.ts",
		"./src/next-js.ts",
		"./src/plugins.ts",
		"./src/client/plugins.ts",
		"./src/stripe.ts",
		"./src/paypal.ts",
		"./src/stripe/client.ts",
	],
	treeshake: true,
});
