"use client";

import { useState } from "react";
import { PaymentTotalsTable } from "@/components/payment-totals";
import { PaymentTrend } from "@/components/payment-trend";
import { Field, Notice, RequestState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

function currentMonth() {
	const today = new Date().toISOString().slice(0, 10);
	return { start: `${today.slice(0, 7)}-01`, end: today };
}
function period(start: string, end: string, interval: "day" | "month") {
	const from = new Date(`${start}T00:00:00Z`);
	const to = new Date(new Date(`${end}T00:00:00Z`).getTime() + 86_400_000);
	if (
		!Number.isFinite(from.getTime()) ||
		!Number.isFinite(to.getTime()) ||
		from >= to ||
		to.getTime() - from.getTime() > 366 * 86_400_000
	)
		throw new Error("请选择先后顺序正确、最多 366 天的日期范围。");
	return { from: from.toISOString(), to: to.toISOString(), interval };
}

export function PaymentStatisticsPanel() {
	const [dates, setDates] = useState(currentMonth);
	const [query, setQuery] = useState(() =>
		period(dates.start, dates.end, "day"),
	);
	const [currency, setCurrency] = useState("");
	const [error, setError] = useState("");
	const resource = useResource(JSON.stringify(query), () =>
		api(authClient.business.admin.paymentStats({ query })),
	);
	const data = resource.data;
	const selected =
		data?.currencies.find((entry) => entry.currency === currency) ??
		data?.currencies[0];
	return (
		<section className="min-w-0 space-y-4" aria-label="付款统计">
			<Card>
				<CardHeader>
					<CardTitle>付款统计</CardTitle>
					<CardDescription>
						按 UTC 付款日期统计已核验订单。不同币种分别汇总，退款回冲原付款期。
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form
						className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto_auto]"
						onSubmit={(event) => {
							event.preventDefault();
							try {
								setQuery(period(dates.start, dates.end, query.interval));
								setError("");
							} catch (cause) {
								setError(
									cause instanceof Error ? cause.message : "日期范围无效。",
								);
							}
						}}
					>
						<Field label="开始日期（UTC）" htmlFor="payment-from">
							<Input
								id="payment-from"
								type="date"
								required
								value={dates.start}
								onChange={(event) =>
									setDates({ ...dates, start: event.target.value })
								}
							/>
						</Field>
						<Field label="结束日期（UTC，含当天）" htmlFor="payment-to">
							<Input
								id="payment-to"
								type="date"
								required
								value={dates.end}
								onChange={(event) =>
									setDates({ ...dates, end: event.target.value })
								}
							/>
						</Field>
						<Button type="submit">查询统计</Button>
						<Button
							type="button"
							variant="outline"
							onClick={resource.reload}
							disabled={resource.loading}
						>
							刷新统计
						</Button>
					</form>
					<div className="mt-3">
						<Notice message={error} />
					</div>
				</CardContent>
			</Card>
			<RequestState {...resource} retry={resource.reload} />
			{data && (
				<>
					<dl className="grid gap-5 rounded-lg border p-5 sm:grid-cols-3">
						<div>
							<dt className="text-sm text-muted-foreground">付款订单数</dt>
							<dd className="mt-1 text-2xl font-semibold tabular-nums">
								{data.paidOrders.toLocaleString()}
							</dd>
						</div>
						<div>
							<dt className="text-sm text-muted-foreground">去重付费人数</dt>
							<dd className="mt-1 text-2xl font-semibold tabular-nums">
								{data.paidUsers.toLocaleString()}
							</dd>
						</div>
						<div>
							<dt className="text-sm text-muted-foreground">
								新注册付费转化率
							</dt>
							<dd className="mt-1 text-2xl font-semibold tabular-nums">
								{data.conversion.rate === null
									? "—"
									: new Intl.NumberFormat("zh-CN", {
											style: "percent",
											maximumFractionDigits: 2,
										}).format(data.conversion.rate)}
							</dd>
							<p className="mt-1 text-xs text-muted-foreground">
								{data.conversion.convertedUsers} /{" "}
								{data.conversion.registeredUsers}{" "}
								位期间新注册用户完成付款，包含所有币种
							</p>
						</div>
					</dl>
					<Card className="min-w-0">
						<CardHeader>
							<CardTitle>收入汇总</CardTitle>
							<CardDescription>
								收款净额 = 收款总额 − 这些订单当前已记录退款；客单价 = 收款总额
								÷ 付款订单数。
							</CardDescription>
						</CardHeader>
						<CardContent>
							{data.currencies.length ? (
								<PaymentTotalsTable rows={data.currencies} />
							) : (
								<p className="py-8 text-center text-sm text-muted-foreground">
									所选期间暂无已核验收款。
								</p>
							)}
						</CardContent>
					</Card>
					{selected && (
						<Card className="min-w-0">
							<CardHeader>
								<CardTitle>收入趋势</CardTitle>
								<CardDescription>
									{selected.currency} · UTC · 无付款日期补零；表格金额为精确值。
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="flex flex-wrap justify-between gap-3">
									<div
										role="group"
										aria-label="趋势粒度"
										className="flex gap-2"
									>
										{(["day", "month"] as const).map((interval) => (
											<Button
												key={interval}
												variant={
													query.interval === interval ? "default" : "outline"
												}
												size="sm"
												aria-pressed={query.interval === interval}
												onClick={() => setQuery({ ...query, interval })}
											>
												{interval === "day" ? "按日" : "按月"}
											</Button>
										))}
									</div>
									<div
										role="group"
										aria-label="统计币种"
										className="flex flex-wrap gap-2"
									>
										{data.currencies.map((entry) => (
											<Button
												key={entry.currency}
												variant={
													entry.currency === selected.currency
														? "default"
														: "outline"
												}
												size="sm"
												aria-pressed={entry.currency === selected.currency}
												onClick={() => setCurrency(entry.currency)}
											>
												{entry.currency}
											</Button>
										))}
									</div>
								</div>
								<PaymentTrend
									key={`${JSON.stringify(query)}:${selected.currency}`}
									value={selected}
									interval={data.period.interval}
								/>
							</CardContent>
						</Card>
					)}
					<p className="text-xs text-muted-foreground">
						统计区间：{new Date(data.period.from).toISOString()} 至{" "}
						{new Date(data.period.to).toISOString()}（结束时刻不含） · 更新于{" "}
						{formatDate(data.generatedAt)}
						。转化率按期间注册且在期间成功付款的当前账户计算，退款不撤销付款事实。
					</p>
				</>
			)}
		</section>
	);
}
