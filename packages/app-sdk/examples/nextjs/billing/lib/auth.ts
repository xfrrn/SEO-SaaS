import { nextCookies } from "@app/auth-sdk/next-js";
import { betterAuth } from "@app/auth-sdk/server";
import { stripe } from "@app/auth-sdk/stripe";
import Stripe from "stripe";
import { database } from "@/lib/database";
import { requiredEnv } from "@/lib/env";

// 将此文件复制到 lib/auth.ts。Stripe 密钥只能存在于服务端。
export const auth = betterAuth({
	secret: requiredEnv("BETTER_AUTH_SECRET"),
	baseURL: requiredEnv("BETTER_AUTH_URL"),
	database,
	emailAndPassword: { enabled: true },
	plugins: [
		stripe({
			stripeClient: new Stripe(requiredEnv("STRIPE_SECRET_KEY")),
			stripeWebhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
			createCustomerOnSignUp: true,
			subscription: {
				enabled: true,
				plans: [
					{
						name: "basic",
						priceId: requiredEnv("STRIPE_PRICE_BASIC_MONTHLY"),
						annualDiscountPriceId: requiredEnv("STRIPE_PRICE_BASIC_YEARLY"),
					},
					{
						name: "pro",
						priceId: requiredEnv("STRIPE_PRICE_PRO_MONTHLY"),
						annualDiscountPriceId: requiredEnv("STRIPE_PRICE_PRO_YEARLY"),
					},
				],
			},
		}),
		nextCookies(),
	],
});
