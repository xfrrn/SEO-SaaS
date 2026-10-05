import type {
	Subscription as CommonSubscription,
	SubscriptionPlan,
} from "@app/subscription/types";
import type {
	GenericEndpointContext,
	InferOptionSchema,
	Session,
	User,
} from "better-auth";
import type { Organization } from "better-auth/plugins/organization";
import type Stripe from "stripe";
import type { organization, subscriptions, user } from "./schema";

export type AuthorizeReferenceAction =
	| "upgrade-subscription"
	| "list-subscription"
	| "cancel-subscription"
	| "restore-subscription"
	| "billing-portal";

export type CustomerType = "user" | "organization";

export type WithStripeCustomerId = {
	stripeCustomerId?: string;
};

// TODO: Types extended by a plugin should be moved into that plugin.
export type WithActiveOrganizationId = {
	activeOrganizationId?: string;
};

export type StripeCtxSession = {
	session: Session & WithActiveOrganizationId;
	user: User & WithStripeCustomerId;
};

export type CheckoutSessionLocale = NonNullable<
	Stripe.Checkout.SessionCreateParams["locale"]
>;

export type CheckoutSessionLineItem = NonNullable<
	Stripe.Checkout.SessionCreateParams["line_items"]
>[number];

export type StripePlan = SubscriptionPlan & {
	/**
	 * Monthly price id
	 */
	priceId?: string | undefined;
	/**
	 * To use lookup key instead of price id
	 *
	 * https://docs.stripe.com/products-prices/
	 * manage-prices#lookup-keys
	 */
	lookupKey?: string | undefined;
	/**
	 * A yearly discount price id
	 *
	 * useful when you want to offer a discount for
	 * yearly subscription
	 */
	annualDiscountPriceId?: string | undefined;
	/**
	 * To use lookup key instead of price id
	 *
	 * https://docs.stripe.com/products-prices/
	 * manage-prices#lookup-keys
	 */
	annualDiscountLookupKey?: string | undefined;
	/**
	 * Per-seat billing price ID
	 *
	 * Requires the `organization` plugin. Member changes
	 * automatically sync the seat quantity in Stripe.
	 */
	seatPriceId?: string | undefined;
	/**
	 * Proration behavior when updating this plan's subscription.
	 *
	 * Controls how Stripe handles mid-cycle price changes.
	 * - `create_prorations`: Add proration line items to the next invoice (default)
	 * - `always_invoice`: Create prorations and immediately invoice
	 * - `none`: No proration; new price applies at next billing cycle
	 *
	 * @default "create_prorations"
	 * @see https://docs.stripe.com/billing/subscriptions/prorations
	 */
	prorationBehavior?:
		| Stripe.SubscriptionUpdateParams.ProrationBehavior
		| undefined;
	/**
	 * Additional line items to include in the checkout session.
	 *
	 * All line items must use the same billing interval as the base price (e.g. all monthly or all yearly).
	 * Stripe does not support mixed-interval subscriptions via Checkout Sessions.
	 *
	 * @see https://docs.stripe.com/billing/subscriptions/mixed-interval#limitations
	 */
	lineItems?: CheckoutSessionLineItem[] | undefined;
	/**
	 * Free trial days
	 */
	freeTrial?:
		| {
				/**
				 * Number of days
				 */
				days: number;
				/**
				 * A function that will be called when the trial
				 * starts.
				 *
				 * @param subscription
				 * @returns
				 */
				onTrialStart?: (subscription: Subscription) => Promise<void>;
				/**
				 * A function that will be called when the trial
				 * ends
				 *
				 * @param subscription - Subscription
				 * @returns
				 */
				onTrialEnd?: (
					data: {
						subscription: Subscription;
					},
					ctx: GenericEndpointContext,
				) => Promise<void>;
				/**
				 * A function that will be called when the trial
				 * expired.
				 * @param subscription - Subscription
				 * @returns
				 */
				onTrialExpired?: (
					subscription: Subscription,
					ctx: GenericEndpointContext,
				) => Promise<void>;
		  }
		| undefined;
};

/** Stripe-specific fields on the shared subscription record. */
export interface Subscription extends CommonSubscription {
	/** Stripe customer id. */
	stripeCustomerId?: string | undefined;
	/** Stripe subscription id. */
	stripeSubscriptionId?: string | undefined;
	/** Price ID exposed by the Stripe subscription list. */
	priceId?: string | undefined;
	/** Stripe schedule ID for a pending plan change. */
	stripeScheduleId?: string | undefined;
}

export type SubscriptionOptions = {
	/**
	 * Subscription Configuration
	 */
	/**
	 * List of plan
	 */
	plans: StripePlan[] | (() => StripePlan[] | Promise<StripePlan[]>);
	/**
	 * Require email verification before a user is allowed to upgrade
	 * their subscriptions
	 *
	 * @default false
	 */
	requireEmailVerification?: boolean | undefined;
	/**
	 * A callback to run after a user has subscribed to a package
	 * @param event - Stripe Event
	 * @param subscription - Subscription Data
	 * @returns
	 */
	onSubscriptionComplete?:
		| ((
				data: {
					event: Stripe.Event;
					stripeSubscription: Stripe.Subscription;
					subscription: Subscription;
					plan: StripePlan;
				},
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
	/**
	 * A callback to run on every subscription update webhook. Use `stripeSubscription`
	 * to read fields that are not persisted in the local subscription row.
	 * @returns
	 */
	onSubscriptionUpdate?:
		| ((data: {
				event: Stripe.Event;
				stripeSubscription: Stripe.Subscription;
				subscription: Subscription;
		  }) => Promise<void>)
		| undefined;
	/**
	 * A callback to run once when a subscription transitions into a pending-cancel state
	 * (e.g. `cancel_at_period_end` or a scheduled `cancel_at`).
	 * @returns
	 */
	onSubscriptionCancel?:
		| ((data: {
				event: Stripe.Event;
				stripeSubscription: Stripe.Subscription;
				subscription: Subscription;
				cancellationDetails?: Stripe.Subscription.CancellationDetails | null;
		  }) => Promise<void>)
		| undefined;
	/**
	 * A function to check if the reference id is valid
	 * and belongs to the user
	 *
	 * @param data - data containing user, session and referenceId
	 * @param ctx - the context object
	 * @returns
	 */
	authorizeReference?:
		| ((
				data: {
					user: User & Record<string, any>;
					session: Session & Record<string, any>;
					referenceId: string;
					action: AuthorizeReferenceAction;
				},
				ctx: GenericEndpointContext,
		  ) => Promise<boolean>)
		| undefined;
	/**
	 * A callback to run after a user has deleted their subscription
	 * @returns
	 */
	onSubscriptionDeleted?:
		| ((data: {
				event: Stripe.Event;
				stripeSubscription: Stripe.Subscription;
				subscription: Subscription;
		  }) => Promise<void>)
		| undefined;
	/**
	 * A callback to run when a subscription is created
	 * @returns
	 */
	onSubscriptionCreated?:
		| ((data: {
				event: Stripe.Event;
				stripeSubscription: Stripe.Subscription;
				subscription: Subscription;
				plan: StripePlan;
		  }) => Promise<void>)
		| undefined;
	/**
	 * parameters for session create params
	 *
	 * @param data - data containing user, session and plan
	 * @param req - the request object
	 * @param ctx - the context object
	 */
	getCheckoutSessionParams?:
		| ((
				data: {
					user: User & Record<string, any>;
					session: Session & Record<string, any>;
					plan: StripePlan;
					subscription: Subscription;
				},
				req: GenericEndpointContext["request"],
				ctx: GenericEndpointContext,
		  ) =>
				| Promise<{
						params?: Stripe.Checkout.SessionCreateParams;
						options?: Stripe.RequestOptions;
				  }>
				| {
						params?: Stripe.Checkout.SessionCreateParams;
						options?: Stripe.RequestOptions;
				  })
		| undefined;
};

export interface StripeOptions {
	/**
	 * Stripe Client
	 */
	stripeClient: Stripe;
	/**
	 * Stripe Webhook Secret
	 *
	 * @description Stripe webhook secret key
	 */
	stripeWebhookSecret: string;
	/**
	 * Enable customer creation when a user signs up
	 */
	createCustomerOnSignUp?: boolean | undefined;
	/**
	 * A callback to run after a customer has been created
	 * @param customer - Customer Data
	 * @param stripeCustomer - Stripe Customer Data
	 * @returns
	 */
	onCustomerCreate?:
		| ((
				data: {
					stripeCustomer: Stripe.Customer;
					user: User & WithStripeCustomerId;
				},
				ctx: GenericEndpointContext,
		  ) => Promise<void>)
		| undefined;
	/**
	 * A custom function to get the customer create
	 * params
	 * @param data - data containing user and session
	 * @returns
	 */
	getCustomerCreateParams?:
		| ((
				user: User,
				ctx: GenericEndpointContext,
		  ) => Promise<Partial<Stripe.CustomerCreateParams>>)
		| undefined;
	/**
	 * Subscriptions
	 */
	subscription?:
		| (
				| {
						enabled: false;
				  }
				| ({
						enabled: true;
				  } & SubscriptionOptions)
		  )
		| undefined;
	/**
	 * Organization Stripe integration
	 *
	 * Enable organizations to have their own Stripe customer ID
	 */
	organization?:
		| {
				/**
				 * Enable organization Stripe customer
				 */
				enabled: true;
				/**
				 * A custom function to get the customer create params
				 * for organization customers.
				 *
				 * @param organization - the organization
				 * @param ctx - the context object
				 * @returns
				 */
				getCustomerCreateParams?:
					| ((
							organization: Organization,
							ctx: GenericEndpointContext,
					  ) => Promise<Partial<Stripe.CustomerCreateParams>>)
					| undefined;
				/**
				 * A callback to run after an organization customer has been created
				 *
				 * @param data - data containing stripeCustomer and organization
				 * @param ctx - the context object
				 * @returns
				 */
				onCustomerCreate?:
					| ((
							data: {
								stripeCustomer: Stripe.Customer;
								organization: Organization & WithStripeCustomerId;
							},
							ctx: GenericEndpointContext,
					  ) => Promise<void>)
					| undefined;
		  }
		| undefined;
	/**
	 * A callback to run after a stripe event is received
	 * @param event - Stripe Event
	 * @returns
	 */
	onEvent?: ((event: Stripe.Event) => Promise<void>) | undefined;
	/**
	 * Schema for the stripe plugin
	 */
	schema?:
		| InferOptionSchema<
				typeof subscriptions & typeof user & typeof organization
		  >
		| undefined;
}
