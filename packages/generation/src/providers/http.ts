import { generationProviderError } from "../primitives";
import type { GenerationOutput } from "../types";

export interface ProviderHTTPOptions {
	apiKey: string;
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
	maxResponseBytes?: number;
	/** Exact hosts, or a leading dot to permit subdomains of an owned CDN. */
	downloadHosts?: string[];
}

async function json(response: Response, maximum: number): Promise<unknown> {
	if (
		!response.body ||
		Number(response.headers.get("content-length")) > maximum
	)
		throw generationProviderError("unknown");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maximum) throw generationProviderError("unknown");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw generationProviderError("unknown");
	}
}

export function providerHTTP(
	options: ProviderHTTPOptions,
	defaultURL: string,
	headers: Record<string, string>,
	downloadHosts: string[],
) {
	const base = new URL(options.baseURL ?? defaultURL);
	if (
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		!options.apiKey?.trim()
	)
		throw new Error(
			"Generation providers require an HTTPS endpoint and server credential",
		);
	if (!base.pathname.endsWith("/")) base.pathname += "/";
	const maximum = options.maxResponseBytes ?? 40 * 1024 * 1024;
	if (!Number.isSafeInteger(maximum) || maximum <= 0)
		throw new Error("Invalid provider response limit");
	const fetcher = options.fetch ?? globalThis.fetch;
	const hosts = options.downloadHosts ?? downloadHosts;
	function allowed(url: URL) {
		return (
			url.protocol === "https:" &&
			!url.username &&
			!url.password &&
			!url.hash &&
			(!url.port || url.port === "443") &&
			hosts.some((host) =>
				host.startsWith(".")
					? url.hostname.endsWith(host)
					: url.hostname === host,
			)
		);
	}
	async function request(
		path: string,
		signal: AbortSignal,
		body?: object | FormData,
		method = body ? "POST" : "GET",
	) {
		const url = new URL(path, base);
		if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
			throw new Error("Invalid provider request path");
		let response: Response;
		try {
			response = await fetcher(url, {
				method,
				signal,
				redirect: "error",
				headers: {
					...headers,
					...(body && !(body instanceof FormData)
						? { "Content-Type": "application/json" }
						: {}),
				},
				...(body
					? { body: body instanceof FormData ? body : JSON.stringify(body) }
					: {}),
			});
		} catch {
			throw generationProviderError("unknown");
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw generationProviderError(
				response.status >= 400 && response.status < 500
					? "rejected"
					: "unknown",
				response.status,
			);
		}
		return json(response, maximum);
	}
	async function readOutput(output: GenerationOutput, signal: AbortSignal) {
		if (!output.url) throw new Error("Generation output URL is missing");
		let url = new URL(output.url);
		for (let redirect = 0; redirect <= 4; redirect++) {
			if (!allowed(url))
				throw new Error("Generation download destination is not allowed");
			const response = await fetcher(url, {
				signal,
				redirect: "manual",
				headers: url.origin === base.origin ? headers : {},
			});
			if (![301, 302, 303, 307, 308].includes(response.status)) return response;
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error("Generation download redirect is invalid");
			url = new URL(location, url);
		}
		throw new Error("Too many generation download redirects");
	}
	return { request, readOutput };
}

export function endpointPath(value: string) {
	if (
		!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) ||
		value.split("/").some((part) => part === "." || part === "..")
	)
		throw new Error("Invalid generation endpoint identifier");
	return value;
}
