import type { BetterAuthClientPlugin } from "better-auth/client";
import { parseJSON } from "better-auth/client";
import type { tickets } from "../tickets";

function preserveText(value: unknown, raw: unknown): unknown {
	if (value instanceof Date) return value;
	if (Array.isArray(value) && Array.isArray(raw))
		return value.map((item, index) => preserveText(item, raw[index]));
	if (value && typeof value === "object" && raw && typeof raw === "object") {
		const original = raw as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				(key === "title" || key === "content") &&
				typeof original[key] === "string"
					? original[key]
					: preserveText(item, original[key]),
			]),
		);
	}
	return value;
}

/** Typed customer and administrator ticket endpoints on the existing auth route. */
export function ticketsClient() {
	return {
		id: "tickets-client",
		$InferServerPlugin: {} as ReturnType<typeof tickets>,
		fetchPlugins: [
			{
				id: "tickets-dates",
				name: "tickets-dates",
				init(url, options) {
					if (!new URL(url, "http://localhost").pathname.includes("/tickets/"))
						return { url, options };
					return {
						url,
						options: {
							...options,
							jsonParser: async (text: string) =>
								preserveText(
									await (options?.jsonParser ?? parseJSON)(text),
									parseJSON(text, { parseDates: false, strict: false }),
								),
						},
					};
				},
			},
		],
		pathMethods: {
			"/tickets/list": "GET",
			"/tickets/get": "GET",
			"/tickets/admin/list": "GET",
			"/tickets/admin/get": "GET",
		},
	} satisfies BetterAuthClientPlugin;
}
