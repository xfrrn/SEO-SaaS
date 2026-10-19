import type { AuthContext } from "better-auth";
import type { MetricsQuery } from "./query";

type Adapter = Pick<AuthContext["adapter"], "count" | "findMany">;
type Query = Exclude<MetricsQuery, { view: "snapshot" }>;
type Registration = { id: string; emailVerified: boolean; createdAt: Date };
type Row = Registration & Partial<Omit<MetricsUser, "createdAt">>;

/** An explicitly projected, current authentication user; never session or profile secrets. */
export interface MetricsUser {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	createdAt: string;
}

/** Current-account registration totals over a bounded UTC half-open interval. */
export interface RegistrationMetrics {
	schemaVersion: 2;
	siteId: string;
	timezone: "UTC";
	generatedAt: string;
	period: { from: string; to: string };
	basis: "current_accounts";
	totalUsers: number;
	registeredUsers: number;
	verifiedUsers: number;
	unverifiedUsers: number;
	daily: { date: string; registrations: number; verifiedUsers: number }[];
}

/** Read-only, separately authorized email list with a fixed page size of twenty. */
export interface MetricsUsersPage {
	schemaVersion: 2;
	siteId: string;
	generatedAt: string;
	period: { from: string; to: string };
	total: number;
	page: number;
	pageSize: 20;
	items: MetricsUser[];
}

function validCount(value: number) {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error("Invalid metrics count");
	return value;
}

async function readUsers(adapter: Adapter, query: Query, signal: AbortSignal) {
	const where = [
		{ field: "createdAt", operator: "gte" as const, value: query.from },
		{ field: "createdAt", operator: "lt" as const, value: query.to },
	];
	const expected = validCount(await adapter.count({ model: "user", where }));
	signal.throwIfAborted();
	if (expected > 10_000) throw new Error("Metrics scan limit exceeded");
	const users = new Map<string, Row>();
	let cursor: string | undefined;
	let scanned = 0;
	// shortcut: cap interval scans at 10,000 accounts; add adapter aggregation for larger sites.
	while (true) {
		signal.throwIfAborted();
		const rows = await adapter.findMany<Row>({
			model: "user",
			where: [
				...where,
				...(cursor
					? [{ field: "id", operator: "gt" as const, value: cursor }]
					: []),
			],
			select:
				query.view === "users"
					? ["id", "name", "email", "emailVerified", "createdAt"]
					: ["id", "emailVerified", "createdAt"],
			sortBy: { field: "id", direction: "asc" },
			limit: Math.min(500, 10_001 - scanned),
		});
		signal.throwIfAborted();
		if (!rows.length) {
			const remaining = validCount(
				await adapter.count({ model: "user", where }),
			);
			signal.throwIfAborted();
			if (expected !== remaining || expected !== users.size)
				throw new Error("Metrics users changed during collection");
			return [...users.values()];
		}
		scanned += rows.length;
		if (scanned > 10_000) throw new Error("Metrics scan limit exceeded");
		for (const row of rows) {
			if (
				typeof row.id !== "string" ||
				!row.id ||
				!(row.createdAt instanceof Date) ||
				!Number.isFinite(row.createdAt.getTime()) ||
				typeof row.emailVerified !== "boolean" ||
				row.createdAt < query.from ||
				row.createdAt >= query.to ||
				users.has(row.id)
			) {
				throw new Error("Invalid metrics user");
			}
			if (
				query.view === "users" &&
				(typeof row.name !== "string" || typeof row.email !== "string")
			) {
				throw new Error("Invalid metrics user details");
			}
			users.set(row.id, row);
		}
		cursor = rows.at(-1)!.id;
	}
}

/** Trusted server service: authorize first, parse the query, and supply a bounded AbortSignal. */
export async function collectRegistrationMetrics(
	adapter: Adapter,
	query: Query,
	siteId: string,
	signal: AbortSignal,
): Promise<RegistrationMetrics | MetricsUsersPage> {
	signal.throwIfAborted();
	const asOf = new Date();
	const boundedQuery = {
		...query,
		to: new Date(Math.min(query.to.getTime(), asOf.getTime())),
	};
	// Retain the handler's collection lock until every in-flight query has settled.
	const results = await Promise.allSettled([
		readUsers(adapter, boundedQuery, signal),
		query.view === "registrations"
			? Promise.resolve()
					.then(() => adapter.count({ model: "user" }))
					.then(validCount)
			: Promise.resolve(0),
	]);
	signal.throwIfAborted();
	const rowsResult = results[0];
	const totalResult = results[1];
	if (rowsResult.status === "rejected") throw rowsResult.reason;
	if (totalResult.status === "rejected") throw totalResult.reason;
	if (query.view === "registrations") {
		const currentTotal = validCount(await adapter.count({ model: "user" }));
		signal.throwIfAborted();
		if (currentTotal !== totalResult.value)
			throw new Error("Metrics users changed during collection");
	}
	const rows = rowsResult.value;
	const base = {
		schemaVersion: 2 as const,
		siteId,
		generatedAt: asOf.toISOString(),
		period: {
			from: query.from.toISOString().slice(0, 10),
			to: query.to.toISOString().slice(0, 10),
		},
	};
	if (query.view === "users") {
		const search = query.q.toLowerCase();
		const found = rows.filter(
			(row) =>
				row.name!.toLowerCase().includes(search) ||
				row.email!.toLowerCase().includes(search),
		);
		found.sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		return {
			...base,
			total: found.length,
			page: query.page,
			pageSize: 20,
			items: found.slice((query.page - 1) * 20, query.page * 20).map((row) => ({
				id: row.id,
				name: row.name!,
				email: row.email!,
				emailVerified: row.emailVerified,
				createdAt: row.createdAt.toISOString(),
			})),
		};
	}
	const daily: RegistrationMetrics["daily"] = [];
	for (
		let date = query.from.getTime();
		date < query.to.getTime();
		date += 86_400_000
	) {
		daily.push({
			date: new Date(date).toISOString().slice(0, 10),
			registrations: 0,
			verifiedUsers: 0,
		});
	}
	let verifiedUsers = 0;
	for (const row of rows) {
		const bucket =
			daily[
				Math.floor(
					(row.createdAt.getTime() - query.from.getTime()) / 86_400_000,
				)
			]!;
		bucket.registrations++;
		if (row.emailVerified) {
			bucket.verifiedUsers++;
			verifiedUsers++;
		}
	}
	return {
		...base,
		timezone: "UTC",
		basis: "current_accounts",
		totalUsers: totalResult.value,
		registeredUsers: rows.length,
		verifiedUsers,
		unverifiedUsers: rows.length - verifiedUsers,
		daily,
	};
}
