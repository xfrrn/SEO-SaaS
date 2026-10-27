import { APIError } from "better-auth";
import * as z from "zod";

export const creditTransactionAdapters = new WeakSet<object>();
export function requireReservationTransaction(adapter: {
	options?: { adapterConfig: { transaction?: unknown } };
}) {
	if (
		!creditTransactionAdapters.has(adapter) &&
		typeof adapter.options?.adapterConfig.transaction !== "function"
	)
		throw new APIError("BAD_REQUEST", {
			code: "CREDITS_TRANSACTIONS_REQUIRED",
			message: "Reservations require a real SQL transaction adapter",
		});
}

export type Batch = {
	grantKey: string;
	remaining: number;
	expiresAt: number | null;
};
const holdsSchema = z.array(
	z.object({
		reservationId: z.string().min(1),
		amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		batches: z.array(
			z.object({
				grantKey: z.string().min(1),
				amount: z.number().int().positive(),
			}),
		),
	}),
);
export type Hold = z.infer<typeof holdsSchema>[number];

export function readHolds(
	value: string | null | undefined,
	batches: Batch[],
): Hold[] {
	const holds = holdsSchema.parse(JSON.parse(value || "[]"));
	if (new Set(holds.map((hold) => hold.reservationId)).size !== holds.length)
		throw new Error("Duplicate credit reservations");
	for (const hold of holds) {
		if (
			hold.batches.reduce((sum, batch) => sum + batch.amount, 0) !==
				hold.amount ||
			new Set(hold.batches.map((batch) => batch.grantKey)).size !==
				hold.batches.length
		)
			throw new Error("Invalid credit reservation allocation");
	}
	for (const key of new Set(
		holds.flatMap((hold) => hold.batches.map((batch) => batch.grantKey)),
	)) {
		const held = heldFor(holds, key);
		const batch = batches.find((batch) => batch.grantKey === key);
		if (
			!batch ||
			batch.expiresAt !== null ||
			batch.remaining < held ||
			!Number.isSafeInteger(held)
		)
			throw new Error("Credit reservations exceed permanent ledger batches");
	}
	return holds;
}
export const heldFor = (holds: Hold[], key: string) =>
	holds.reduce(
		(sum, hold) =>
			sum +
			hold.batches
				.filter((batch) => batch.grantKey === key)
				.reduce((total, batch) => total + batch.amount, 0),
		0,
	);
export const heldTotal = (holds: Hold[]) =>
	holds.reduce((sum, hold) => sum + hold.amount, 0);

/** All ordinary consumption also respects frozen allocations. */
export function takeAvailable(batches: Batch[], holds: Hold[], amount: number) {
	batches.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
	for (const batch of batches) {
		const used = Math.min(
			batch.remaining - heldFor(holds, batch.grantKey),
			amount,
		);
		batch.remaining -= used;
		amount -= used;
		if (!amount) return;
	}
	throw new Error("Spendable credits do not match the ledger");
}

/** Initial reservations use permanent credits; expiring batches remain spendable normally. */
export function reservePermanent(
	batches: Batch[],
	holds: Hold[],
	reservationId: string,
	amount: number,
): Hold {
	const allocations: Hold["batches"] = [];
	let remaining = amount;
	for (const batch of batches) {
		if (batch.expiresAt !== null) continue;
		const used = Math.min(
			batch.remaining - heldFor(holds, batch.grantKey),
			remaining,
		);
		if (used > 0) allocations.push({ grantKey: batch.grantKey, amount: used });
		remaining -= used;
		if (!remaining) return { reservationId, amount, batches: allocations };
	}
	throw new APIError("BAD_REQUEST", {
		code: "INSUFFICIENT_PERMANENT_CREDITS",
		message: "Insufficient unreserved permanent credits",
	});
}
