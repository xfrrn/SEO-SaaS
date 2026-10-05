import { defineConfig } from "tsdown";

export default defineConfig({
	dts: { build: true, incremental: true },
	format: ["esm"],
	entry: [
		"./src/index.ts",
		"./src/client.ts",
		"./src/schema.ts",
		"./src/types.ts",
		"./src/utils.ts",
	],
	treeshake: true,
});
