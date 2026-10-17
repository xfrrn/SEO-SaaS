import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";

describe("SDK Google login", () => {
	it("uses native social configuration, PKCE and the mounted auth callback", async () => {
		const { client } = await getTestInstance({
			advanced: { disableOriginCheck: false },
			socialProviders: {
				google: {
					clientId: "website.apps.googleusercontent.com",
					clientSecret: "server-only-google-secret",
					prompt: "select_account",
				},
			},
		});
		const result = await client.signIn.social({
			provider: "google",
			callbackURL: "/account",
			errorCallbackURL: "/login",
			disableRedirect: true,
		});
		expect(result.error).toBeNull();
		const url = new URL(result.data!.url!);
		expect(url.origin + url.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(url.searchParams.get("client_id")).toBe(
			"website.apps.googleusercontent.com",
		);
		expect(url.searchParams.get("redirect_uri")).toBe(
			"http://localhost:3000/api/auth/callback/google",
		);
		expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
			"email",
			"openid",
			"profile",
		]);
		expect(url.searchParams.get("prompt")).toBe("select_account");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBeTruthy();
		expect(url.searchParams.get("state")).toBeTruthy();
		expect(url.toString()).not.toContain("server-only-google-secret");

		for (const field of ["callbackURL", "errorCallbackURL"] as const) {
			const rejected = await client.signIn.social({
				provider: "google",
				callbackURL: "/account",
				errorCallbackURL: "/login",
				[field]: "https://untrusted.example/return",
				disableRedirect: true,
			});
			expect(rejected.error?.status).toBe(403);
		}
	});
});
