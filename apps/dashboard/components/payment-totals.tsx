"use client";

import type { PaymentTotals } from "@app/auth-sdk/business";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/format";

export function PaymentTotalsTable({ rows }: { rows: PaymentTotals[] }) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					{[
						"币种",
						"付款订单",
						"收款总额",
						"已记录退款",
						"收款净额",
						"客单价",
					].map((label) => (
						<TableHead key={label} className="whitespace-nowrap">
							{label}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => (
					<TableRow key={row.currency}>
						<TableCell className="font-medium">{row.currency}</TableCell>
						<TableCell className="tabular-nums">
							{row.paidOrders.toLocaleString()}
						</TableCell>
						{[
							row.grossAmount,
							row.refundedAmount,
							row.netAmount,
							row.averageOrderAmount,
						].map((amount, index) => (
							<TableCell
								key={["gross", "refund", "net", "average"][index]}
								className="whitespace-nowrap tabular-nums"
							>
								{amount === null ? "—" : money(amount, row.currency)}
							</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
