/** Only the selected channel is enabled; secrets never appear in browser configuration. */
export function readPaymentConfig(
	env: Record<string, string | undefined> = process.env,
) {
	const provider = env.PAYMENT_PROVIDER?.trim();
	if (!provider || provider === "none") return undefined;
	const required = (name: string) => {
		const value = env[name]?.trim();
		if (!value) throw new Error(`${name} is required for ${provider}.`);
		return value;
	};
	if (provider === "stripe")
		return {
			provider,
			secretKey: required("STRIPE_SECRET_KEY"),
			webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
		} as const;
	if (provider === "paypal") {
		const environment = env.PAYPAL_ENVIRONMENT?.trim() || "sandbox";
		if (environment !== "sandbox" && environment !== "live")
			throw new Error("PAYPAL_ENVIRONMENT must be sandbox or live.");
		return {
			provider,
			environment,
			clientId: required("PAYPAL_CLIENT_ID"),
			clientSecret: required("PAYPAL_CLIENT_SECRET"),
			webhookId: required("PAYPAL_WEBHOOK_ID"),
		} as const;
	}
	throw new Error("PAYMENT_PROVIDER must be none, stripe or paypal.");
}
