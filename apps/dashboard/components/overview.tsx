"use client";

import { useEffect, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { RequestState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate, money, orderStatus } from "@/lib/format";

const statuses = [
	"pending",
	"paid",
	"fulfilled",
	"partially_refunded",
	"refunded",
] as const;
const colors = ["#a3a3a3", "#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];

export function Overview({ onOpenOrders }: { onOpenOrders: () => void }) {
	const resource = useResource("overview", async () => {
		const [metrics, recent, counts] = await Promise.all([
			api(authClient.business.admin.overview()),
			api(authClient.business.admin.orders({ query: { limit: 5, offset: 0 } })),
			Promise.all(
				statuses.map(async (status) => ({
					status,
					name: orderStatus[status],
					total: (
						await api(
							authClient.business.admin.orders({
								query: { status, limit: 1, offset: 0 },
							}),
						)
					).total,
				})),
			),
		]);
		return { metrics, recent, counts };
	});
	const [reducedMotion, setReducedMotion] = useState(true);
	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setReducedMotion(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	if (!resource.data)
		return <RequestState {...resource} retry={resource.reload} />;
	const { metrics, recent, counts } = resource.data;
	const cards = [
		{ label: "用户总数", value: metrics.totalUsers, note: "当前注册账户" },
		{
			label: "近 7 天新增",
			value: metrics.newUsers7d,
			note: "最近 7 × 24 小时",
		},
		{
			label: "本月付费人数",
			value: metrics.paidUsersThisMonth,
			note: metrics.paymentsConfigured
				? "UTC 自然月 · 包含退款后的付款"
				: "支付未配置 · 保留已记录历史",
		},
		{
			label: "待履约订单",
			value: counts.find((item) => item.status === "paid")!.total,
			note: "已核验付款，等待授予权益",
		},
	];
	return (
		<div className="space-y-4">
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
				{cards.map((card) => (
					<Card key={card.label}>
						<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
							<CardTitle className="text-sm font-medium">
								{card.label}
							</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="text-2xl font-bold tabular-nums">
								{card.value.toLocaleString()}
							</div>
							<p className="mt-1 text-xs text-muted-foreground">{card.note}</p>
						</CardContent>
					</Card>
				))}
			</div>
			<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
				<Card className="min-w-0 lg:col-span-4">
					<CardHeader>
						<CardTitle>订单概览</CardTitle>
						<CardDescription>已记录订单的当前状态分布</CardDescription>
					</CardHeader>
					<CardContent className="pl-2">
						{recent.total > 0 ? (
							<div
								className="h-[350px] w-full min-w-0"
								role="img"
								aria-label={counts
									.map((item) => `${item.name} ${item.total} 笔`)
									.join("，")}
							>
								<ResponsiveContainer width="100%" height="100%">
									<BarChart
										data={counts}
										margin={{ left: -10, right: 18, bottom: 10 }}
									>
										<CartesianGrid
											strokeDasharray="3 3"
											stroke="hsl(var(--border))"
											vertical={false}
										/>
										<XAxis
											dataKey="name"
											tick={{
												fontSize: 12,
												fill: "hsl(var(--muted-foreground))",
											}}
											tickLine={false}
											axisLine={false}
										/>
										<YAxis
											allowDecimals={false}
											tick={{
												fontSize: 12,
												fill: "hsl(var(--muted-foreground))",
											}}
											tickLine={false}
											axisLine={false}
										/>
										<Tooltip
											cursor={{ fill: "hsl(var(--muted))" }}
											contentStyle={{
												background: "hsl(var(--popover))",
												color: "hsl(var(--popover-foreground))",
												border: "1px solid hsl(var(--border))",
												borderRadius: 8,
											}}
										/>
										<Bar
											dataKey="total"
											name="订单数"
											maxBarSize={48}
											isAnimationActive={!reducedMotion}
										>
											{counts.map((item, index) => (
												<Cell key={item.status} fill={colors[index]} />
											))}
										</Bar>
									</BarChart>
								</ResponsiveContainer>
							</div>
						) : (
							<div className="flex h-[350px] items-center justify-center px-8 text-center text-sm text-muted-foreground">
								还没有订单。网站产生订单后，这里会显示实际分布。
							</div>
						)}
					</CardContent>
				</Card>
				<Card className="min-w-0 lg:col-span-3">
					<CardHeader className="flex flex-row items-start justify-between gap-3">
						<div className="space-y-1.5">
							<CardTitle>最近订单</CardTitle>
							<CardDescription>
								共 {recent.total.toLocaleString()} 笔已记录订单
							</CardDescription>
						</div>
						<Button variant="ghost" size="sm" onClick={onOpenOrders}>
							查看全部
						</Button>
					</CardHeader>
					<CardContent>
						{recent.orders.length ? (
							<div className="space-y-6">
								{recent.orders.map((order) => (
									<div
										key={order.id}
										className="flex items-start justify-between gap-4"
									>
										<div className="min-w-0 space-y-1">
											<p className="truncate text-sm font-medium">
												{order.product.name}
											</p>
											<p
												className="truncate text-xs text-muted-foreground"
												title={order.referenceId}
											>
												{order.referenceId}
											</p>
											<p className="text-xs text-muted-foreground">
												{formatDate(order.createdAt)}
											</p>
										</div>
										<div className="shrink-0 space-y-2 text-right">
											<p className="text-sm font-medium tabular-nums">
												{money(order.amount, order.currency)}
											</p>
											<Badge variant="secondary">
												{orderStatus[order.status]}
											</Badge>
										</div>
									</div>
								))}
							</div>
						) : (
							<p className="py-16 text-center text-sm text-muted-foreground">
								暂时没有订单记录。
							</p>
						)}
					</CardContent>
				</Card>
			</div>
			<p className="text-xs text-muted-foreground">
				更新于 {formatDate(metrics.generatedAt)} ·
				付费人数仅统计已核验的本地业务订单。
			</p>
		</div>
	);
}
