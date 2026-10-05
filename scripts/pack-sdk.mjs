import { spawnSync } from "node:child_process";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const readJSON = async (path) => JSON.parse(await readFile(path, "utf8"));

/** Keep native package boundaries and conditional exports inside one SDK tarball. */
export async function stageSDK(root, destination) {
	const workspace = parse(
		await readFile(join(root, "pnpm-workspace.yaml"), "utf8"),
	);
	const packages = new Map();
	for (const directory of await readdir(join(root, "packages"), {
		withFileTypes: true,
	})) {
		if (!directory.isDirectory()) continue;
		const path = join(root, "packages", directory.name);
		try {
			const manifest = await readJSON(join(path, "package.json"));
			packages.set(manifest.name, { path, manifest });
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	const sdk = packages.get("@app/auth-sdk");
	if (!sdk) throw new Error("Missing packages/app-sdk/package.json");
	const included = new Map();
	function visit(pkg) {
		if (included.has(pkg.manifest.name)) return;
		included.set(pkg.manifest.name, pkg);
		for (const [name, version] of Object.entries({
			...pkg.manifest.dependencies,
			...pkg.manifest.optionalDependencies,
			...pkg.manifest.peerDependencies,
		})) {
			if (!version.startsWith("workspace:")) continue;
			const dependency = packages.get(name);
			if (!dependency) throw new Error(`Missing workspace dependency ${name}`);
			visit(dependency);
		}
	}
	visit(sdk);

	function version(name, range) {
		if (range.startsWith("workspace:"))
			return packages.get(name).manifest.version;
		if (!range.startsWith("catalog:")) return range;
		const catalog = range.slice("catalog:".length);
		const value = (
			catalog ? workspace.catalogs?.[catalog] : workspace.catalog
		)?.[name];
		if (!value) throw new Error(`Missing ${range} entry for ${name}`);
		return value;
	}
	function publishedManifest(original) {
		const result = {
			...original,
			files: ["dist"],
			devDependencies: undefined,
			scripts: undefined,
			packageManager: undefined,
		};
		if (result.exports) {
			// Source-only development conditions must not point outside the tarball.
			const withoutSourceCondition = (value) => {
				if (Array.isArray(value)) return value.map(withoutSourceCondition);
				if (!value || typeof value !== "object") return value;
				return Object.fromEntries(
					Object.entries(value)
						.filter(([key]) => key !== "dev-source")
						.map(([key, item]) => [key, withoutSourceCondition(item)]),
				);
			};
			result.exports = withoutSourceCondition(result.exports);
		}
		for (const field of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			if (result[field]) {
				result[field] = Object.fromEntries(
					Object.entries(result[field]).map(([name, range]) => [
						name,
						version(name, range),
					]),
				);
			}
		}
		return result;
	}
	const manifest = publishedManifest(sdk.manifest);
	manifest.dependencies = {};
	manifest.optionalDependencies = {};
	manifest.peerDependencies = {};
	manifest.peerDependenciesMeta = {};
	manifest.bundledDependencies = [...included.keys()].filter(
		(name) => name !== sdk.manifest.name,
	);

	// pnpm does not resolve dependencies of bundled packages. Expose their external
	// dependencies on the SDK, pinned to the versions used by this source checkout.
	for (const pkg of included.values()) {
		for (const field of ["dependencies", "optionalDependencies"]) {
			for (const [name] of Object.entries(pkg.manifest[field] ?? {})) {
				if (included.has(name)) continue;
				const installed = await readJSON(
					join(pkg.path, "node_modules", name, "package.json"),
				);
				const prior =
					manifest.dependencies[name] ?? manifest.optionalDependencies[name];
				if (prior && prior !== installed.version) {
					throw new Error(
						`Conflicting installed versions for ${name}: ${prior}, ${installed.version}`,
					);
				}
				manifest[field][name] = installed.version;
			}
		}
		for (const [name, range] of Object.entries(
			pkg.manifest.peerDependencies ?? {},
		)) {
			if (included.has(name)) continue;
			manifest.peerDependencies[name] ??= version(name, range);
			if (pkg.manifest.peerDependenciesMeta?.[name]?.optional) {
				manifest.peerDependenciesMeta[name] = { optional: true };
			}
		}
	}
	for (const name of manifest.bundledDependencies) {
		manifest.dependencies[name] = included.get(name).manifest.version;
	}
	for (const field of [
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
	]) {
		const entries = Object.entries(manifest[field]).filter(
			([name]) => !Object.hasOwn(manifest.dependencies, name),
		);
		manifest[field] = entries.length ? Object.fromEntries(entries) : undefined;
	}

	await mkdir(destination, { recursive: true });
	// A separate workspace keeps pack from finding development dependencies in the
	// source tree. Hoisted here describes physical copies, not the source install.
	await writeFile(
		join(destination, "pnpm-workspace.yaml"),
		"packages: []\nnodeLinker: hoisted\n",
	);
	for (const pkg of included.values()) {
		const target =
			pkg === sdk
				? destination
				: join(destination, "node_modules", pkg.manifest.name);
		await mkdir(target, { recursive: true });
		await cp(join(pkg.path, "dist"), join(target, "dist"), { recursive: true });
		await writeFile(
			join(target, "package.json"),
			`${JSON.stringify(pkg === sdk ? manifest : publishedManifest(pkg.manifest), null, 2)}\n`,
		);
		for (const file of ["README.md", "LICENSE", "LICENSE.md"]) {
			try {
				await cp(join(pkg.path, file), join(target, file));
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
	await cp(join(root, "LICENSE.md"), join(destination, "LICENSE.md"));
	return manifest;
}

async function main() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const output = join(root, "dist", "auth-sdk.tgz");
	const temporaryRoot = resolve(tmpdir());
	const stage = await mkdtemp(join(temporaryRoot, "auth-sdk-pack-"));
	try {
		const manifest = await stageSDK(root, stage);
		await mkdir(dirname(output), { recursive: true });
		const args = ["pack", "--out", "auth-sdk.tgz", "--json"];
		const executable = process.env.npm_execpath;
		const result =
			executable && /pnpm\.(?:c?js|mjs)$/.test(executable)
				? spawnSync(process.execPath, [executable, ...args], {
						cwd: stage,
						encoding: "utf8",
					})
				: spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
						cwd: stage,
						encoding: "utf8",
						shell: process.platform === "win32",
					});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(result.stderr || result.stdout);
		await cp(join(stage, "auth-sdk.tgz"), output);
		console.log(
			`Created ${output} with ${manifest.bundledDependencies.length} local packages.`,
		);
	} finally {
		// Remove only this invocation's freshly-created directory under the temp root.
		if (
			dirname(resolve(stage)) !== temporaryRoot ||
			!basename(stage).startsWith("auth-sdk-pack-")
		) {
			throw new Error(`Refusing to remove unexpected staging path: ${stage}`);
		}
		await rm(stage, { recursive: true, force: true });
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	await main();
}
