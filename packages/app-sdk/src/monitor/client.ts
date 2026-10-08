/** Encode optional browser attribution for signup, OAuth initiation and order creation. Never fails a business request. */
export function monitorHeaders(context: unknown): Record<string, string> {
	try {
		if (
			!context ||
			typeof context !== "object" ||
			!("schema_version" in context) ||
			context.schema_version !== 1 ||
			!("site_id" in context) ||
			typeof context.site_id !== "string" ||
			!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(context.site_id)
		)
			return {};
		const bytes = new TextEncoder().encode(JSON.stringify(context));
		if (bytes.length > 3072) return {};
		const encoded = btoa(String.fromCharCode(...bytes))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replaceAll("=", "");
		return { "X-Monitor-Context": encoded };
	} catch {
		return {};
	}
}
