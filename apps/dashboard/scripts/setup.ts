import { createAdminAuditService } from "@app/auth-sdk/plugins";
import { getMigrations } from "better-auth/db/migration";
import { closeAuth, getAuth } from "../lib/auth.ts";
import { readAdminConfig, readAuthConfig } from "../lib/auth-config.ts";

let stage = "configuration";
try {
	readAuthConfig();
	const administrator = readAdminConfig();
	stage = "database initialization";
	const auth = getAuth();
	stage = "migration";
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();
	console.log("Dashboard database migrations completed.");
	stage = "administrator lookup";
	const { adapter, internalAdapter } = await auth.$context;
	const existing = await internalAdapter.findUserByEmail(administrator.email);
	if (existing) {
		console.error(
			"This email already belongs to a user. No password or role was changed. Use the existing account or choose an unused administrator email.",
		);
		process.exitCode = 1;
	} else {
		stage = "administrator creation";
		const { user } = await auth.api.createUser({
			body: { ...administrator, role: "admin" },
		});
		stage = "bootstrap audit";
		await createAdminAuditService(adapter).record({
			operationId: `dashboard-bootstrap:${user.id}`,
			actorId: "system",
			action: "dashboard.bootstrap",
			targetId: user.id,
			reason: "Explicit local administrator setup",
			status: "succeeded",
		});
		console.log(
			"Initial administrator created. Sign in with the credentials supplied through your environment, then remove DASHBOARD_ADMIN_PASSWORD from .env.local.",
		);
	}
} catch (error) {
	// Configuration messages are generated locally and contain variable names only.
	console.error(
		stage === "configuration" && error instanceof Error
			? error.message
			: `Dashboard setup failed during ${stage}. Check the database connection, migration state, and account records. Credentials were not printed.`,
	);
	process.exitCode = 1;
} finally {
	try {
		await closeAuth();
	} catch {
		console.error("Dashboard database shutdown failed.");
		process.exitCode = 1;
	}
}
