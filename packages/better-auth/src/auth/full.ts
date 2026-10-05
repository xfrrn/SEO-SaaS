import type { BetterAuthOptions } from "@better-auth/core";
import { init } from "../context/init";
import type { Auth } from "../types";
import { createBetterAuth } from "./base";

/**
 * Better Auth initializer for full mode (with Kysely)
 *
 * @example
 * ```ts
 * import { betterAuth } from "better-auth";
 * import { Pool } from "pg";
 *
 * const auth = betterAuth({
 * 	database: new Pool({ connectionString: process.env.DATABASE_URL }),
 * });
 * ```
 *
 * For minimal mode with a custom database adapter (without Kysely), import from
 * `better-auth/minimal` instead.
 */
export const betterAuth = <Options extends BetterAuthOptions>(
	options: Options & {},
): Auth<Options> => {
	return createBetterAuth(options, init);
};
