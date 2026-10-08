import { getMigrations } from "better-auth/db/migration";
import { closeAuth, getAuth } from "../lib/auth";

/** Explicitly migrate and seed only the randomly isolated test database. */
export default async function setup() {
	const auth = getAuth();
	try {
		const { runMigrations } = await getMigrations(auth.options);
		await runMigrations();
		for (const role of ["admin", "user"] as const) {
			const { user } = await auth.api.createUser({
				body: {
					name: role === "admin" ? "验收管理员" : "验收普通用户",
					email: `${role}@dashboard-e2e.example`,
					password: process.env.DASHBOARD_E2E_PASSWORD!,
					role,
				},
			});
			process.env[`DASHBOARD_E2E_${role.toUpperCase()}_ID`] = user.id;
		}
	} finally {
		await closeAuth();
	}
	// Compile the real catch-all route before timing browser assertions on a cold dev server.
	const response = await fetch(
		`${process.env.BETTER_AUTH_URL}/api/auth/get-session`,
		{
			signal: AbortSignal.timeout(120_000),
		},
	);
	if (!response.ok)
		throw new Error(`Session warmup failed: ${response.status}`);
}
