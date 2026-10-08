import type { BetterAuthClientPlugin } from "better-auth/client";
import { parseJSON } from "better-auth/client";
import type { business } from "./index";

function preserveJSONDates(
	value: unknown,
	raw: unknown,
	json: boolean,
): unknown {
	if (value instanceof Date)
		return json && typeof raw === "string" ? raw : value;
	if (Array.isArray(value) && Array.isArray(raw)) {
		return value.map((item, index) =>
			preserveJSONDates(item, raw[index], json),
		);
	}
	if (
		value &&
		typeof value === "object" &&
		raw &&
		typeof raw === "object" &&
		!Array.isArray(raw)
	) {
		const original = raw as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				preserveJSONDates(
					item,
					original[key],
					json || key === "product" || key === "limits" || key === "details",
				),
			]),
		);
	}
	return value;
}

/** Add purchase and administrative endpoints; verified payment writes stay server-only. */
export function businessClient() {
	return {
		id: "business-client",
		$InferServerPlugin: {} as ReturnType<typeof business>,
		fetchPlugins: [
			{
				id: "business-json-dates",
				name: "business-json-dates",
				init(url, options) {
					const path = new URL(url, "http://localhost").pathname;
					const route = path.slice(path.lastIndexOf("/business/"));
					if (!route.startsWith("/business/")) return { url, options };
					const json = [
						"/business/admin/credits/adjust",
						"/business/admin/membership/adjust",
						"/business/admin/products/save",
						"/business/admin/products/publish",
					].includes(route);
					const parser = options?.jsonParser ?? parseJSON;
					return {
						url,
						options: {
							...options,
							// Keep custom parser behavior; restore only dates inside declared JSON fields.
							jsonParser: async (text: string) =>
								preserveJSONDates(
									await parser(text),
									parseJSON(text, { parseDates: false, strict: false }),
									json,
								),
						},
					};
				},
			},
		],
	} satisfies BetterAuthClientPlugin;
}
