import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	rmdir,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { stageSDK } from "./pack-sdk.mjs";

async function linkInstalledDependencies(root, stage, manifest) {
	const workspaces = (
		await readdir(join(root, "packages"), { withFileTypes: true })
	)
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, "packages", entry.name));
	for (const [name, version] of Object.entries({
		...manifest.dependencies,
		...manifest.optionalDependencies,
	})) {
		if (manifest.bundledDependencies.includes(name)) continue;
		let installed;
		for (const workspace of [root, ...workspaces]) {
			try {
				const candidate = await realpath(join(workspace, "node_modules", name));
				if (
					JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))
						.version === version
				) {
					installed = candidate;
					break;
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
		assert.ok(installed, `Missing installed dependency ${name}@${version}`);
		const target = join(stage, "node_modules", name);
		await mkdir(dirname(target), { recursive: true });
		await symlink(
			installed,
			target,
			process.platform === "win32" ? "junction" : "dir",
		);
	}
}

async function assertPluginConsumers(stage) {
	const mediaRuntime = join(stage, "media-consumer.mjs");
	await writeFile(
		mediaRuntime,
		'export { createMediaEngineClient, verifyMediaEngineEvent, verifyMediaEngineNotification, applyMediaEngineAction } from "@app/auth-sdk/media-engine"; export { withCreditsTransaction } from "@app/auth-sdk/credits";',
	);
	const mediaEntry = await import(pathToFileURL(mediaRuntime).href);
	assert.equal(typeof mediaEntry.createMediaEngineClient, "function");
	assert.equal(typeof mediaEntry.verifyMediaEngineEvent, "function");
	assert.equal(typeof mediaEntry.verifyMediaEngineNotification, "function");
	assert.equal(typeof mediaEntry.applyMediaEngineAction, "function");
	assert.equal(typeof mediaEntry.withCreditsTransaction, "function");
	const delivery = mediaEntry.createMediaEngineClient({
		base_url: "https://engine.example",
		api_key: "packaging-only-key",
	});
	for (const method of [
		"soundtrackURL",
		"derivatives",
		"prepareDerivative",
		"completeDerivative",
		"derivativeURL",
	])
		assert.equal(
			typeof delivery[method],
			"function",
			`Missing media delivery method ${method}`,
		);
	const programmaticRuntime = join(stage, "programmatic-consumer.mjs");
	await writeFile(
		programmaticRuntime,
		`
export { apiKey } from "@app/auth-sdk/api-key";
export { apiKeyClient } from "@app/auth-sdk/api-key/client";
export { redisStorage } from "@app/auth-sdk/redis-storage";
export { mcp, requireMcpAuth, createMcpProtectedRequestHandler } from "@app/auth-sdk/mcp";
`,
	);
	const programmatic = await import(pathToFileURL(programmaticRuntime).href);
	assert.equal(programmatic.apiKey().id, "api-key");
	assert.equal(programmatic.apiKeyClient().id, "api-key");
	assert.equal(typeof programmatic.redisStorage, "function");
	assert.equal(typeof programmatic.requireMcpAuth, "function");
	assert.ok(
		programmatic.mcp({
			loginPage: "/login",
			consentPage: "/consent",
			resource: "https://example.test/mcp",
		}).endpoints,
	);
	const protectedHandler = programmatic.createMcpProtectedRequestHandler(
		{
			issuer: "https://example.test/api/auth",
			audience: "https://example.test/mcp",
		},
		() => {
			throw new Error("Unauthenticated MCP handler must not execute");
		},
	);
	const unauthorized = await protectedHandler(
		new Request("https://example.test/mcp"),
	);
	assert.equal(unauthorized.status, 401);
	assert.match(
		unauthorized.headers.get("WWW-Authenticate"),
		/resource_metadata=/,
	);
	const i18nRuntime = join(stage, "i18n-consumer.mjs");
	await writeFile(
		i18nRuntime,
		`
export { i18n, locales } from "@app/auth-sdk/i18n";
export { i18nClient } from "@app/auth-sdk/i18n/client";
export { zh } from "@app/auth-sdk/i18n/locales";
export { betterAuth } from "@app/auth-sdk/server";
`,
	);
	const translated = await import(pathToFileURL(i18nRuntime).href);
	assert.equal(
		translated.i18n({
			translations: { zh: translated.zh },
			defaultLocale: "zh",
		}).id,
		"i18n",
	);
	assert.equal(translated.i18nClient().id, "i18n");
	assert.equal(
		translated.zh.INVALID_EMAIL_OR_PASSWORD,
		translated.locales.zh.INVALID_EMAIL_OR_PASSWORD,
	);
	assert.ok(translated.zh.INVALID_EMAIL_OR_PASSWORD);
	const auth = translated.betterAuth({
		baseURL: "http://localhost:3000",
		secret: "packaging-test-secret-at-least-32-characters",
		emailAndPassword: { enabled: true },
		plugins: [translated.i18n({ translations: translated.locales })],
	});
	const response = await auth.api.signInEmail({
		body: { email: "missing@example.com", password: "wrong-password" },
		headers: { "Accept-Language": "zh-CN" },
		asResponse: true,
	});
	assert.equal(response.status, 401);
	const error = await response.json();
	assert.equal(error.code, "INVALID_EMAIL_OR_PASSWORD");
	assert.equal(error.message, translated.zh.INVALID_EMAIL_OR_PASSWORD);
	assert.equal(
		error.originalMessage,
		translated.locales.en.INVALID_EMAIL_OR_PASSWORD,
	);
	const generationRuntime = join(stage, "generation-consumer.mjs");
	await writeFile(
		generationRuntime,
		`
export { generation, createGenerationService } from "@app/auth-sdk/generation";
export { generationClient } from "@app/auth-sdk/generation/client";
export { createOpenAIGenerationProvider } from "@app/auth-sdk/generation/providers/openai";
export { createGoogleGenerationProvider, createGoogleInteractionsGenerationProvider } from "@app/auth-sdk/generation/providers/google";
export { createFalGenerationProvider } from "@app/auth-sdk/generation/providers/fal";
export { createKieGenerationProvider, kieNanoBanana2Adapter, kieNanoBanana2Parameters, kieGrokTextToVideoAdapter, kieGrokImageToVideoAdapter } from "@app/auth-sdk/generation/providers/kie";
`,
	);
	const generationEntry = await import(pathToFileURL(generationRuntime).href);
	for (const name of [
		"generation",
		"createGenerationService",
		"generationClient",
		"createOpenAIGenerationProvider",
		"createGoogleGenerationProvider",
		"createGoogleInteractionsGenerationProvider",
		"createFalGenerationProvider",
		"createKieGenerationProvider",
	])
		assert.equal(
			typeof generationEntry[name],
			"function",
			`Missing generation export ${name}`,
		);
	const generationTypes = join(stage, "generation-consumer.mts");
	await writeFile(
		generationTypes,
		`
import { generation, createGenerationService } from "@app/auth-sdk/generation";
import type { GenerationOptions, GenerationProvider, GenerationJob, ProviderResult } from "@app/auth-sdk/generation";
import { generationClient } from "@app/auth-sdk/generation/client";
import { createOpenAIGenerationProvider, openAIImageParameters } from "@app/auth-sdk/generation/providers/openai";
import { createGoogleGenerationProvider, googleVideoParameters } from "@app/auth-sdk/generation/providers/google";
import { createFalGenerationProvider } from "@app/auth-sdk/generation/providers/fal";
import { createKieGenerationProvider, kieNanoBanana2Adapter, kieNanoBanana2Parameters } from "@app/auth-sdk/generation/providers/kie";
import type { KieModelAdapter } from "@app/auth-sdk/generation/providers/kie";
const kieMapping: KieModelAdapter = kieNanoBanana2Adapter;
const kie: GenerationProvider = createKieGenerationProvider({ apiKey: "consumer-test", downloadHosts: ["cdn.example"], models: { "nano-banana-2": kieMapping } });
declare const options: GenerationOptions;
const plugin = generation(options);
const client = generationClient();
const provider: GenerationProvider = createOpenAIGenerationProvider({ apiKey: "consumer-test" });
const google: GenerationProvider = createGoogleGenerationProvider({ apiKey: "consumer-test" });
declare const job: GenerationJob;
const state: GenerationJob["status"] = "needs_reconciliation";
const result: ProviderResult = { status: "running", taskId: "consumer-test" };
`,
	);
	const runtimeConsumer = join(stage, "moderation-consumer.mjs");
	await writeFile(runtimeConsumer, 'export * from "@app/auth-sdk/moderation";');
	const entry = await import(pathToFileURL(runtimeConsumer).href);
	for (const name of [
		"moderation",
		"createModeration",
		"createModerationStore",
		"createOpenAIModerationDetector",
		"createTextRulesDetector",
		"createSeeAPIModerationDetector",
	])
		assert.equal(
			typeof entry[name],
			"function",
			`Missing runtime export ${name}`,
		);
	assert.equal(
		entry.createTextRulesDetector({
			version: "consumer-test",
			literal_terms: [{ term: "fixture", category: "violence" }],
		}).capabilities[0].inspection_scope,
		"text.rules",
	);
	const source = join(stage, "consumer.mts");
	await writeFile(
		source,
		`
import { moderation, createModeration, createOpenAIModerationDetector, createTextRulesDetector } from "@app/auth-sdk/moderation";
import { createSeeAPIModerationDetector } from "@app/auth-sdk/moderation";
import type { ProviderModerationEvidence } from "@app/auth-sdk/moderation";
const seeapi: ModerationDetector = createSeeAPIModerationDetector({ api_key: "consumer-test", base_url: "https://api.seeapi.com", version: "consumer-v1" });
import { i18n } from "@app/auth-sdk/i18n";
import type { I18nOptions } from "@app/auth-sdk/i18n";
import { i18nClient } from "@app/auth-sdk/i18n/client";
import { en, zh } from "@app/auth-sdk/i18n/locales";
const translationOptions: I18nOptions<["en", "zh"]> = { translations: { en, zh }, defaultLocale: "en" };
const translationPlugin = i18n(translationOptions);
const translationClient = i18nClient();
import { apiKey } from "@app/auth-sdk/api-key";
import { apiKeyClient } from "@app/auth-sdk/api-key/client";
import type { ApiKeyOptions } from "@app/auth-sdk/api-key/types";
import { redisStorage } from "@app/auth-sdk/redis-storage";
import type { RedisStorageConfig } from "@app/auth-sdk/redis-storage";
import { mcp, createMcpProtectedRequestHandler } from "@app/auth-sdk/mcp";
import type { McpOptions } from "@app/auth-sdk/mcp";
const keyOptions: ApiKeyOptions = {};
const keyPlugin = apiKey(undefined, keyOptions);
const keyClient = apiKeyClient();
declare const redisConfig: RedisStorageConfig;
const secondary = redisStorage(redisConfig);
const mcpOptions: McpOptions = { loginPage: "/login", consentPage: "/consent", resource: "https://example.test/mcp" };
const mcpPlugin = mcp(mcpOptions);
const protectedHandler = createMcpProtectedRequestHandler({ issuer: "https://example.test/api/auth", audience: mcpOptions.resource }, () => new Response("ok"));
import type { CheckCoverage, CheckReport, CheckRequest, EvaluationRequest, EvaluationResult, Finding, ModerationDetector, ModerationOptions, OpenAIModerationOptions } from "@app/auth-sdk/moderation";
declare const host: ModerationOptions;
declare const evaluation: EvaluationRequest;
declare const check: CheckRequest;
const service = createModeration(host);
const result: Promise<EvaluationResult> = service.evaluate(evaluation);
const report: Promise<CheckReport> = service.check(check);
const plugin = moderation(host);
const openAI: (options: OpenAIModerationOptions) => ModerationDetector = createOpenAIModerationDetector;
const rules: ModerationDetector = createTextRulesDetector({ version: "consumer-test", literal_terms: [{ term: "fixture", category: "violence" }] });
const mode: CheckCoverage["mode"] = "shadow";
const flagged: Finding["native_flagged"] = null;
`,
	);
	const program = ts.createProgram([source, generationTypes], {
		noEmit: true,
		strict: true,
		skipLibCheck: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		target: ts.ScriptTarget.ES2022,
		types: [],
	});
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => stage,
			getNewLine: () => "\n",
		}),
	);
}

test("packaged SDK includes generation, moderation, ticket, client and migration entrypoints with declarations", async () => {
	const temporaryRoot = resolve(tmpdir());
	const stage = await mkdtemp(join(temporaryRoot, "auth-sdk-entries-"));
	try {
		const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const manifest = await stageSDK(root, stage);
		assert.ok(manifest.bundledDependencies.includes("@app/generation"));
		assert.ok(manifest.bundledDependencies.includes("@better-auth/i18n"));
		for (const name of [
			"@better-auth/api-key",
			"@better-auth/redis-storage",
			"@better-auth/mcp",
			"@better-auth/oauth-provider",
		]) {
			assert.ok(
				manifest.bundledDependencies.includes(name),
				`Missing bundled package ${name}`,
			);
		}
		assert.equal(manifest.peerDependenciesMeta.ioredis.optional, true);
		for (const name of [
			"api-key",
			"api-key/client",
			"api-key/types",
			"redis-storage",
			"mcp",
			"i18n",
			"i18n/client",
			"i18n/locales",
			"generation",
			"generation/client",
			"generation/providers/openai",
			"generation/providers/google",
			"generation/providers/fal",
			"generation/providers/kie",
			"moderation",
			"tickets",
			"tickets/client",
			"migrations",
		]) {
			const entry = manifest.exports[`./${name}`];
			assert.equal(entry["dev-source"], undefined);
			assert.ok(
				(await readFile(join(stage, entry.default), "utf8")).length > 0,
			);
			assert.ok((await readFile(join(stage, entry.types), "utf8")).length > 0);
		}
		assert.match(
			await readFile(join(stage, "README.md"), "utf8"),
			/用户反馈工单/,
		);
		await linkInstalledDependencies(root, stage, manifest);
		await assertPluginConsumers(stage);
	} finally {
		assert.equal(dirname(resolve(stage)), temporaryRoot);
		await rm(stage, { recursive: true, force: true });
	}
});

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
				dependencies: {
					"@app/business": "workspace:^",
					"@app/waffo": "workspace:^",
				},
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
			waffo: {
				name: "@app/waffo",
				version: "0.1.0",
				type: "module",
				exports: { ".": "./dist/index.mjs" },
				dependencies: { "@waffo/pancake-ts": "0.26.0" },
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
		const pancake = join(
			source,
			"packages",
			"waffo",
			"node_modules",
			"@waffo",
			"pancake-ts",
		);
		await mkdir(pancake, { recursive: true });
		await writeFile(
			join(pancake, "package.json"),
			JSON.stringify({ name: "@waffo/pancake-ts", version: "0.26.0" }),
		);
		const manifest = await stageSDK(source, stage);
		assert.deepEqual(manifest.bundledDependencies.sort(), [
			"@app/business",
			"@app/credits",
			"@app/subscription",
			"@app/waffo",
			"@better-auth/core",
			"@better-auth/stripe",
			"better-auth",
		]);
		assert.equal(manifest.dependencies["shared-runtime"], "1.2.3");
		assert.equal(manifest.dependencies["@waffo/pancake-ts"], "0.26.0");
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
