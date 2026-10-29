import type { BusinessOrder } from "@app/auth-sdk/business";
import { getAuth, getPayments } from "../../../../lib/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signed notifications recover purchases even when a customer closes the checkout tab. */
export async function POST(request: Request) {
	try {
		const contentLength = Number(request.headers.get("content-length") ?? 0);
		if (contentLength > 256 * 1024) {
			return Response.json({ error: "Payload too large" }, { status: 413 });
		}
		const payments = getPayments();
		if (!payments.webhook) return new Response(null, { status: 404 });
		const receipt = await payments.webhook(request);
		if (!receipt) return Response.json({ received: true });
		const auth = getAuth();
		const { adapter } = await auth.$context;
		const order = await adapter.findOne<BusinessOrder>({
			model: "businessOrder",
			where: [{ field: "id", value: receipt.orderId }],
		});
		// Other applications can share a provider account. Only this site's orders belong here.
		if (!order || order.provider !== receipt.provider)
			return Response.json({ received: true });
		// A notification may beat checkout persistence; a non-2xx response asks the provider to retry.
		if (!order.providerOrderId)
			throw new Error("Checkout is not yet persisted");
		if (
			receipt.reference !== undefined &&
			order.providerOrderId !== receipt.reference
		)
			throw new Error("Checkout does not match order");
		await auth.api.confirmBusinessPayment({
			body: { orderId: order.id, reference: order.providerOrderId },
		});
		return Response.json({ received: true });
	} catch {
		console.error(
			"[payments] Notification verification or fulfillment failed; delivery can be retried.",
		);
		return Response.json(
			{ error: "Payment notification could not be processed" },
			{ status: 503 },
		);
	}
}
