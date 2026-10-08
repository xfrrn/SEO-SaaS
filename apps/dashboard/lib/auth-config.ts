type Environment = Record<string, string | undefined>;

/** Validate server configuration without opening a database or exposing credentials. */
export function readAuthConfig(env: Environment = process.env) {
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret || secret.trim().length < 32) {
		throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
	}
	let baseURL: URL;
	try {
		baseURL = new URL(env.BETTER_AUTH_URL ?? "");
	} catch {
		throw new Error("BETTER_AUTH_URL must be an HTTP(S) origin.");
	}
	if (
		!["http:", "https:"].includes(baseURL.protocol) ||
		baseURL.username ||
		baseURL.password ||
		baseURL.search ||
		baseURL.hash ||
		baseURL.pathname !== "/"
	)
		throw new Error(
			"BETTER_AUTH_URL must be an HTTP(S) origin without a path or credentials.",
		);
	const connectionString = env.DATABASE_URL?.trim();
	const sqlitePath = env.DASHBOARD_SQLITE_PATH?.trim();
	if (!!connectionString === !!sqlitePath) {
		throw new Error(
			"Set exactly one of DATABASE_URL or DASHBOARD_SQLITE_PATH.",
		);
	}
	if (connectionString) {
		let url: URL;
		try {
			url = new URL(connectionString);
		} catch {
			throw new Error("DATABASE_URL must be a PostgreSQL URL.");
		}
		if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
			throw new Error("DATABASE_URL must be a PostgreSQL URL.");
		}
		return {
			secret,
			baseURL: baseURL.origin,
			database: { kind: "postgres" as const, connectionString },
		};
	}
	if (env.NODE_ENV === "production") {
		throw new Error(
			"Production requires PostgreSQL; DASHBOARD_SQLITE_PATH is for local development.",
		);
	}
	if (sqlitePath === ":memory:") {
		throw new Error(
			"DASHBOARD_SQLITE_PATH must point to a persistent local file.",
		);
	}
	return {
		secret,
		baseURL: baseURL.origin,
		database: { kind: "sqlite" as const, path: sqlitePath! },
	};
}

/** Bootstrap credentials are used only by the explicit setup command. */
export function readAdminConfig(env: Environment = process.env) {
	const email = env.DASHBOARD_ADMIN_EMAIL?.trim().toLowerCase();
	const password = env.DASHBOARD_ADMIN_PASSWORD;
	const name = env.DASHBOARD_ADMIN_NAME?.trim() || "Administrator";
	if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		throw new Error(
			"Set DASHBOARD_ADMIN_EMAIL to the initial administrator's email.",
		);
	}
	if (!password || password.length < 12 || password.length > 128) {
		throw new Error("DASHBOARD_ADMIN_PASSWORD must contain 12–128 characters.");
	}
	if (name.length > 255)
		throw new Error("DASHBOARD_ADMIN_NAME must be at most 255 characters.");
	return { email, password, name };
}
