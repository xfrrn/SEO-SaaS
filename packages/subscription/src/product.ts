import type { DBAdapter } from "@better-auth/core/db/adapter";
import { APIError } from "better-auth";
import * as z from "zod";

const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const key = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9][a-z0-9_-]*$/);

/** Validate a complete new product version; zero means the key must not exist. */
export const saveProductSchema = z
	.object({
		key,
		expectedVersion: z
			.number()
			.int()
			.min(0)
			.max(Number.MAX_SAFE_INTEGER - 1),
		name: z.string().trim().min(1).max(255),
		type: z.enum(["credits", "membership", "bundle"]),
		amount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		currency: z.string().regex(/^[A-Z]{3}$/),
		credits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
		membershipDays: positiveInteger.max(36_500).nullable().default(null),
		creditValidityDays: positiveInteger.max(36_500).nullable().default(null),
		limits: z.record(z.string(), z.json()).default({}),
		published: z.boolean().default(false),
	})
	.superRefine((value, ctx) => {
		if (
			(value.type === "credits" || value.type === "bundle") &&
			!value.credits
		) {
			ctx.addIssue({
				code: "custom",
				message: "Credit products require positive credits",
				path: ["credits"],
			});
		}
		if (
			(value.type === "membership" || value.type === "bundle") &&
			!value.membershipDays
		) {
			ctx.addIssue({
				code: "custom",
				message: "Membership products require membershipDays",
				path: ["membershipDays"],
			});
		}
		if (value.type === "credits" && value.membershipDays !== null) {
			ctx.addIssue({
				code: "custom",
				message: "Credits-only products cannot grant membership",
				path: ["membershipDays"],
			});
		}
		if (
			value.type === "membership" &&
			(value.credits !== 0 || value.creditValidityDays !== null)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Membership-only products cannot grant credits",
				path: ["credits"],
			});
		}
	});

/** Validate publication changes using the version shown in the editor. */
export const publishProductSchema = z.object({
	key,
	expectedVersion: positiveInteger,
	published: z.boolean(),
});

/** Input for creating an immutable catalog version. */
export type SaveProductInput = z.input<typeof saveProductSchema>;

/** Immutable catalog snapshot. Publication is historical; check getLatest before selling. */
export type Product = Omit<
	z.output<typeof saveProductSchema>,
	"expectedVersion"
> & {
	id: string;
	version: number;
	createdAt: Date;
};

type ProductRecord = Product & { versionKey: string };

/** Stable subscription plan identifier for a specific immutable product version. */
export function productPlanName(product: Pick<Product, "id">): string {
	return `product:${product.id}`;
}

function publicProduct({
	versionKey: _versionKey,
	...product
}: ProductRecord): Product {
	return product;
}

/** Store catalog versions on a trusted server; callers must authorize mutations. */
export function createProductService(
	adapter: Pick<DBAdapter, "create" | "findOne" | "findMany" | "count">,
) {
	async function get(id: string): Promise<Product | null> {
		const row = await adapter.findOne<ProductRecord>({
			model: "subscriptionProduct",
			where: [{ field: "id", value: z.string().min(1).max(255).parse(id) }],
		});
		return row ? publicProduct(row) : null;
	}
	async function getLatest(productKey: string): Promise<Product | null> {
		const rows = await adapter.findMany<ProductRecord>({
			model: "subscriptionProduct",
			where: [{ field: "key", value: key.parse(productKey) }],
			sortBy: { field: "version", direction: "desc" },
			limit: 1,
		});
		return rows[0] ? publicProduct(rows[0]) : null;
	}
	async function save(input: SaveProductInput): Promise<Product> {
		const { expectedVersion, ...fields } = saveProductSchema.parse(input);
		const latest = await getLatest(fields.key);
		if ((latest?.version ?? 0) !== expectedVersion) {
			throw new APIError("CONFLICT", {
				message: "Product changed concurrently; reload before saving",
			});
		}
		const version = expectedVersion + 1;
		const data = {
			...fields,
			version,
			versionKey: JSON.stringify([fields.key, version]),
			createdAt: new Date(),
		};
		// The unique version key makes concurrent append attempts atomic, without a transaction.
		try {
			const row = await adapter.create<typeof data, ProductRecord>({
				model: "subscriptionProduct",
				data,
			});
			return publicProduct(row);
		} catch (error) {
			// Inspect error codes without issuing queries in an aborted PostgreSQL transaction.
			let cause: unknown = error;
			for (
				let depth = 0;
				depth < 5 && cause && typeof cause === "object";
				depth++
			) {
				if (
					("code" in cause &&
						[
							"23505",
							"P2002",
							"ER_DUP_ENTRY",
							"SQLITE_CONSTRAINT_UNIQUE",
							"SQLITE_CONSTRAINT_PRIMARYKEY",
						].includes(String(cause.code))) ||
					("errcode" in cause &&
						[2067, 1555].includes(Number(cause.errcode))) ||
					("errno" in cause && cause.errno === 1062)
				) {
					throw new APIError("CONFLICT", {
						message: "Product changed concurrently; reload before saving",
					});
				}
				cause = "cause" in cause ? cause.cause : undefined;
			}
			throw error;
		}
	}
	async function list(
		input: { publishedOnly?: boolean; limit?: number; offset?: number } = {},
	): Promise<Product[]> {
		const { publishedOnly, limit, offset } = z
			.object({
				publishedOnly: z.boolean().default(false),
				limit: z.number().int().min(1).max(1000).default(100),
				offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
			})
			.parse(input);
		const count = await adapter.count({ model: "subscriptionProduct" });
		if (!count) return [];
		// ponytail: catalog histories are scanned; add a transaction-backed head table for large catalogs.
		const rows = await adapter.findMany<ProductRecord>({
			model: "subscriptionProduct",
			sortBy: { field: "version", direction: "desc" },
			limit: count,
		});
		const latest = new Map<string, Product>();
		for (const row of rows)
			if (!latest.has(row.key)) latest.set(row.key, publicProduct(row));
		return [...latest.values()]
			.filter((product) => !publishedOnly || product.published)
			.sort((a, b) => a.key.localeCompare(b.key))
			.slice(offset, offset + limit);
	}
	async function setPublished(
		input: z.input<typeof publishProductSchema>,
	): Promise<Product> {
		const value = publishProductSchema.parse(input);
		const current = await getLatest(value.key);
		if (!current)
			throw new APIError("NOT_FOUND", { message: "Product not found" });
		return save({ ...current, ...value });
	}
	return { save, get, getLatest, list, setPublished };
}
