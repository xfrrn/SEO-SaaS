import { defineConfig } from "tsdown";

export default defineConfig({
	dts: { build: true, incremental: true },
	format: ["esm"],
	entry: [
		"./src/index.ts",
		"./src/client.ts",
		"./src/providers/openai.ts",
		"./src/providers/google.ts",
		"./src/providers/fal.ts",
	],
	treeshake: true,
});
