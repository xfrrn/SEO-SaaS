"use client";

import type { BusinessPaymentStatistics } from "@app/auth-sdk/business";
import { useState } from "react";
import {
	CartesianGrid,
	Legend,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Pagination } from "@/components/shared";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { currencyDigits, money } from "@/lib/format";

export function PaymentTrend({
	value,
	interval,
}: {
	value: BusinessPaymentStatistics["currencies"][number];
	interval: "day" | "month";
}) {
	const [offset, setOffset] = useState(0);
	const rows = value.trend.map((row) => ({
		...row,
		label: new Date(row.periodStart)
			.toISOString()
			.slice(0, interval === "day" ? 10 : 7),
	}));
	return (
		<div className="space-y-4">
			<div
				className="h-[280px] min-w-0"
				role="img"
				aria-label={`${value.currency} ${interval === "day" ? "每日" : "每月"}收款与净额趋势，下方提供完整数据表`}
			>
				<ResponsiveContainer width="100%" height="100%">
					<LineChart
						data={rows}
						margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
					>
						<CartesianGrid stroke="hsl(var(--border))" vertical={false} />
						<XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={36} />
						<YAxis
							width={65}
							tick={{ fontSize: 12 }}
							tickFormatter={(amount: number) =>
								new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(
									amount / 10 ** currencyDigits(value.currency),
								)
							}
						/>
						<Tooltip
							formatter={(amount) =>
								typeof amount === "number" ? money(amount, value.currency) : "—"
							}
							contentStyle={{
								background: "hsl(var(--background))",
								borderColor: "hsl(var(--border))",
								color: "hsl(var(--foreground))",
							}}
						/>
						<Legend />
						<Line
							dataKey="grossAmount"
							name="收款总额"
							stroke="hsl(var(--foreground))"
							strokeWidth={2}
							dot={false}
							isAnimationActive={false}
						/>
						<Line
							dataKey="netAmount"
							name="收款净额"
							stroke="hsl(var(--muted-foreground))"
							strokeDasharray="6 4"
							strokeWidth={2}
							dot={false}
							isAnimationActive={false}
						/>
					</LineChart>
				</ResponsiveContainer>
			</div>
			<Table>
				<TableHeader>
					<TableRow>
						{[
							"UTC 日期",
							"付款订单",
							"付费人数",
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
					{rows.slice(offset, offset + 20).map((row) => (
						<TableRow key={row.label}>
							<TableCell className="whitespace-nowrap">{row.label}</TableCell>
							<TableCell>{row.paidOrders}</TableCell>
							<TableCell>{row.paidUsers}</TableCell>
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
									{amount === null ? "—" : money(amount, value.currency)}
								</TableCell>
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
			{rows.length > 20 && (
				<Pagination
					limit={20}
					offset={offset}
					total={rows.length}
					onChange={setOffset}
				/>
			)}
		</div>
	);
}
