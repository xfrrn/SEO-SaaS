import * as sdkClientPlugins from "@app/auth-sdk/client/plugins";
import * as sdkCredits from "@app/auth-sdk/credits";
import * as sdkCreditsClient from "@app/auth-sdk/credits/client";
import * as sdkNextJS from "@app/auth-sdk/next-js";
import * as sdkPayPal from "@app/auth-sdk/paypal";
import * as sdkPlugins from "@app/auth-sdk/plugins";
import * as sdkReact from "@app/auth-sdk/react";
import * as sdkServer from "@app/auth-sdk/server";
import * as sdkStripe from "@app/auth-sdk/stripe";
import * as sdkStripeClient from "@app/auth-sdk/stripe/client";
import * as sdkSubscription from "@app/auth-sdk/subscription";
import * as sdkSubscriptionClient from "@app/auth-sdk/subscription/client";
import * as nativeCredits from "@app/credits";
import * as nativeCreditsClient from "@app/credits/client";
import * as nativePayPal from "@app/paypal";
import * as nativeSubscription from "@app/subscription";
import * as nativeSubscriptionClient from "@app/subscription/client";
import * as nativeStripe from "@better-auth/stripe";
import * as nativeStripeClient from "@better-auth/stripe/client";
import * as nativeServer from "better-auth";
import * as nativeClientPlugins from "better-auth/client/plugins";
import * as nativeNextJS from "better-auth/next-js";
import * as nativePlugins from "better-auth/plugins";
import * as nativeReact from "better-auth/react";
import { getTestInstance } from "better-auth/test";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("SDK native compatibility", () => {
	it("re-exports the original values from every entrypoint", () => {
		for (const [sdk, native] of [
			[sdkServer, nativeServer],
			[sdkReact, nativeReact],
			[sdkNextJS, nativeNextJS],
			[sdkPlugins, nativePlugins],
			[sdkClientPlugins, nativeClientPlugins],
			[sdkCredits, nativeCredits],
			[sdkCreditsClient, nativeCreditsClient],
			[sdkStripe, nativeStripe],
			[sdkStripeClient, nativeStripeClient],
			[sdkPayPal, nativePayPal],
			[sdkSubscription, nativeSubscription],
			[sdkSubscriptionClient, nativeSubscriptionClient],
		] as const) {
			expect(Object.keys(sdk).sort()).toEqual(Object.keys(native).sort());
			for (const [name, value] of Object.entries(native)) {
				expect(Reflect.get(sdk, name)).toBe(value);
			}
		}
	});

	it("exposes PayPal expiration helpers and error types through the SDK", () => {
		const client = sdkPayPal.createPayPalClient({
			clientId: "test-client",
			clientSecret: "test-secret",
			webhookId: "test-webhook",
			orderExpiration: true,
		});
		expect(client.calculateOrderExpiresAt(0)).toBe(30 * 60 * 1000);
		expectTypeOf(client.assertOrderPayable).toBeFunction();
		expectTypeOf<sdkPayPal.PayPalOrderExpiredError>().toEqualTypeOf<nativePayPal.PayPalOrderExpiredError>();
		expectTypeOf<
			sdkPayPal.PayPalOrderExpiredError["code"]
		>().toEqualTypeOf<"PAYPAL_ORDER_EXPIRED">();
		expect(sdkPayPal.isPayPalOrderExpiredError).toBe(
			nativePayPal.isPayPalOrderExpiredError,
		);
	});

	it("preserves registration, login, session, logout and plugin calls", async () => {
		const { client, auth, sessionSetter } = await getTestInstance(
			{ plugins: [sdkPlugins.username()] },
			{
				disableTestUser: true,
				clientOptions: { plugins: [sdkClientPlugins.usernameClient()] },
			},
		);
		const user = {
			email: "sdk@example.com",
			password: "sdk-password-123",
			name: "SDK User",
			username: "sdk_user",
		};
		const registered = await client.signUp.email(user, { throw: true });
		expect(registered.user.email).toBe(user.email);
		await expect(auth.api.getSession()).rejects.toThrow("Headers is required");
		expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();

		const headers = new Headers();
		await client.signIn.email(user, {
			throw: true,
			onSuccess: sessionSetter(headers),
		});
		const session = await client.getSession({ fetchOptions: { headers } });
		expect(session.data?.user.id).toBe(registered.user.id);
		expect(session.data?.user.username).toBe(user.username);
		expect((await auth.api.getSession({ headers }))?.user.id).toBe(
			registered.user.id,
		);

		await client.signOut({ fetchOptions: { headers, throw: true } });
		expect(await auth.api.getSession({ headers })).toBeNull();
		const usernameLogin = await client.signIn.username({
			username: user.username,
			password: user.password,
		});
		expect(usernameLogin.data?.user.id).toBe(registered.user.id);
	});

	it("keeps React plugin inference and required server request headers", () => {
		const usernamePlugin = sdkClientPlugins.usernameClient();
		type BasicClient = ReturnType<typeof sdkReact.createAuthClient<{}>>;
		type UsernameClient = ReturnType<
			typeof sdkReact.createAuthClient<{
				plugins: [typeof usernamePlugin];
			}>
		>;
		type Auth = ReturnType<typeof sdkServer.betterAuth<{}>>;
		// Type-check object inputs without sending requests at runtime.
		const checkSessionHeaders = (auth: Auth) => {
			// @ts-expect-error An empty object does not provide request headers.
			auth.api.getSession({});
			auth.api.getSession({ headers: new Headers() });
		};

		expectTypeOf<BasicClient["signIn"]["email"]>().toBeFunction();
		expectTypeOf<BasicClient["useSession"]>().toBeFunction();
		expectTypeOf<UsernameClient["signIn"]["username"]>().toBeFunction();
		expectTypeOf<"username">().not.toExtend<keyof BasicClient["signIn"]>();
		expectTypeOf<"subscription">().not.toExtend<keyof BasicClient>();
		expectTypeOf<"credits">().not.toExtend<keyof BasicClient>();
		expectTypeOf<Auth["api"]["getSession"]>().toEqualTypeOf<
			nativeServer.Auth<{}>["api"]["getSession"]
		>();
		expectTypeOf(checkSessionHeaders).toBeFunction();
	});
});
