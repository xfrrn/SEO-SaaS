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
		for (const [directory, manifest] of Object.entries({
			"app-sdk": {
				name: "@app/auth-sdk",
				version: "0.1.0",
				type: "module",
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
			"@better-auth/core",
			"@better-auth/stripe",
			"better-auth",
		]);
		assert.equal(manifest.dependencies["shared-runtime"], "1.2.3");
		assert.equal(manifest.peerDependencies["better-auth"], undefined);
		assert.equal(manifest.peerDependenciesMeta.stripe.optional, true);
		assert.equal(manifest.peerDependenciesMeta.react.optional, true);
		assert.equal(manifest.devDependencies, undefined);
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
