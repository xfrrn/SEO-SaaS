import * as z from "zod";
import { date } from "../validation";

/** UTC instants with an exclusive end; one report covers at most 366 days. */
export const paymentStatsQuery = z
	.strictObject({
		from: date,
		to: date,
		interval: z.enum(["day", "month"]).default("day"),
	})
	.refine(
		({ from, to }) =>
			from < to && to.getTime() - from.getTime() <= 366 * 86_400_000,
		"Choose a valid reporting period of at most 366 days",
	);
