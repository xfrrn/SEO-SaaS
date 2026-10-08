import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	rmdir,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stageSDK } from "./pack-sdk.mjs";

test("SDK contains custom native packages and preserves optional framework and payment peers", async () => {
	const temporaryRoot = resolve(tmpdir());
	const fixture = await mkdtemp(join(temporaryRoot, "auth-sdk-test-"));
	try {
		const source = join(fixture, "source");
		const stage = join(fixture, "package");
		await mkdir(source);
		await writeFile(
			join(source, "pnpm-workspace.yaml"),
			"catalog:\n  shared-runtime: ^1.0.0\n",
		);
		await writeFile(join(source, "LICENSE.md"), "MIT fixture");
		const conditionalExport = {
			types: "./dist/index.d.mts",
			node: "./dist/node.mjs",
			workerd: "./dist/worker.mjs",
			edge: "./dist/edge.mjs",
			default: "./dist/index.mjs",
		};
		const businessExport = {
			types: "./dist/business.d.mts",
			default: "./dist/business.mjs",
		};
		const businessClientExport = {
			types: "./dist/business/client.d.mts",
			default: "./dist/business/client.mjs",
		};
		const nativeClientExport = {
			types: "./dist/client.d.mts",
			default: "./dist/client.mjs",
		};
		for (const [directory, manifest] of Object.entries({
			"app-sdk": {
				name: "@app/auth-sdk",
				version: "0.1.0",
				type: "module",
				exports: {
					"./business": {
						"dev-source": "./src/business.ts",
						...businessExport,
					},
					"./business/client": {
						"dev-source": "./src/business/client.ts",
						...businessClientExport,
					},
				},
				dependencies: { "@app/business": "workspace:^" },
				peerDependencies: {
					"better-auth": "workspace:^",
					"@better-auth/stripe": "workspace:^",
					react: "^19",
					stripe: "^22",
				},
				peerDependenciesMeta: {
					"@better-auth/stripe": { optional: true },
					react: { optional: true },
					stripe: { optional: true },
				},
				devDependencies: { unused: "99.0.0" },
			},
			business: {
				name: "@app/business",
				version: "0.1.0",
				type: "module",
				exports: {
					".": {
						"dev-source": "./src/index.ts",
						types: "./dist/index.d.mts",
						default: "./dist/index.mjs",
					},
					"./client": {
						"dev-source": "./src/client.ts",
						...nativeClientExport,
					},
				},
				dependencies: {
					"@app/credits": "workspace:^",
					"@app/subscription": "workspace:^",
				},
				peerDependencies: { "better-auth": "workspace:^" },
			},
			credits: {
				name: "@app/credits",
				version: "0.1.0",
				type: "module",
				exports: { ".": "./dist/index.mjs" },
			},
			subscription: {
				name: "@app/subscription",
				version: "0.1.0",
				type: "module",
				exports: { ".": "./dist/index.mjs" },
			},
			"better-auth": {
				name: "better-auth",
				version: "1.7.6",
				type: "module",
				exports: {
					".": { "dev-source": "./src/index.ts", ...conditionalExport },
				},
				dependencies: {
					"@better-auth/core": "workspace:*",
					"shared-runtime": "catalog:",
				},
			},
			core: {
				name: "@better-auth/core",
				version: "1.7.6",
				type: "module",
				peerDependencies: { "better-auth": "workspace:^" },
			},
			stripe: {
				name: "@better-auth/stripe",
				version: "1.7.6",
				type: "module",
				peerDependencies: { "better-auth": "workspace:^", stripe: "^22" },
			},
		})) {
			const path = join(source, "packages", directory);
			await mkdir(join(path, "dist"), { recursive: true });
			await writeFile(join(path, "package.json"), JSON.stringify(manifest));
			await writeFile(
				join(path, "dist", "index.mjs"),
				'export const marker = "custom-auth-source";',
			);
		}
		const sdkDist = join(source, "packages", "app-sdk", "dist");
		await mkdir(join(sdkDist, "business"));
		for (const [file, code] of [
			[join(sdkDist, "business.mjs"), 'export * from "@app/business";'],
			[
				join(sdkDist, "business", "client.mjs"),
				'export * from "@app/business/client";',
			],
			[
				join(source, "packages", "business", "dist", "index.mjs"),
				'export { marker as credits } from "@app/credits"; export { marker as subscription } from "@app/subscription";',
			],
			[
				join(source, "packages", "business", "dist", "client.mjs"),
				'export const businessClient = "bundled-client";',
			],
		])
			await writeFile(file, code);
		const external = join(
			source,
			"packages",
			"better-auth",
			"node_modules",
			"shared-runtime",
		);
		await mkdir(external, { recursive: true });
		await writeFile(
			join(external, "package.json"),
			JSON.stringify({ name: "shared-runtime", version: "1.2.3" }),
		);
		const manifest = await stageSDK(source, stage);
		assert.deepEqual(manifest.bundledDependencies.sort(), [
			"@app/business",
			"@app/credits",
			"@app/subscription",
			"@better-auth/core",
			"@better-auth/stripe",
			"better-auth",
		]);
		assert.equal(manifest.dependencies["shared-runtime"], "1.2.3");
		assert.equal(manifest.peerDependencies["better-auth"], undefined);
		assert.equal(manifest.peerDependenciesMeta.stripe.optional, true);
		assert.equal(manifest.peerDependenciesMeta.react.optional, true);
		assert.equal(manifest.devDependencies, undefined);
		assert.deepEqual(manifest.exports["./business"], businessExport);
		assert.deepEqual(
			manifest.exports["./business/client"],
			businessClientExport,
		);
		const business = JSON.parse(
			await readFile(
				join(stage, "node_modules", "@app/business", "package.json"),
				"utf8",
			),
		);
		assert.deepEqual(business.dependencies, {
			"@app/credits": "0.1.0",
			"@app/subscription": "0.1.0",
		});
		assert.deepEqual(business.exports["./client"], nativeClientExport);
		assert.equal(business.exports["."]["dev-source"], undefined);
		const server = await import(
			pathToFileURL(join(stage, "dist", "business.mjs")).href
		);
		assert.equal(server.credits, "custom-auth-source");
		assert.equal(server.subscription, "custom-auth-source");
		const client = await import(
			pathToFileURL(join(stage, "dist", "business", "client.mjs")).href
		);
		assert.equal(client.businessClient, "bundled-client");
		const bundled = JSON.parse(
			await readFile(
				join(stage, "node_modules", "better-auth", "package.json"),
				"utf8",
			),
		);
		assert.deepEqual(bundled.exports["."], conditionalExport);
		assert.equal(bundled.dependencies["@better-auth/core"], "1.7.6");
		assert.equal(bundled.dependencies["shared-runtime"], "^1.0.0");
		assert.match(
			await readFile(
				join(stage, "node_modules", "better-auth", "dist", "index.mjs"),
				"utf8",
			),
			/custom-auth-source/,
		);
		await rm(join(source, "packages", "core", "dist", "index.mjs"));
		await rmdir(join(source, "packages", "core", "dist"));
		await assert.rejects(stageSDK(source, join(fixture, "missing-build")), {
			code: "ENOENT",
		});
	} finally {
		assert.equal(dirname(resolve(fixture)), temporaryRoot);
		await rm(fixture, { recursive: true, force: true });
	}
});
