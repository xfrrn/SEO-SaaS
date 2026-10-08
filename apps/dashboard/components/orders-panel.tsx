"use client";

import type { BusinessOrder } from "@app/auth-sdk/business";
import type { FormEvent } from "react";
import { useState } from "react";
import { Field, Notice, Pagination, RequestState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, errorMessage, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate, money, orderStatus } from "@/lib/format";

const selectStyle =
	"h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50";

function canRetry(order: BusinessOrder) {
	return (
		!!order.paidAt &&
		!!order.paymentId &&
		!order.fulfilledAt &&
		order.status !== "refunded"
	);
}

/** View verified order records and retry paid fulfillment without charging again. */
export function OrdersPanel() {
	const [offset, setOffset] = useState(0);
	const limit = 20;
	const [reference, setReference] = useState("");
	const [status, setStatus] = useState<BusinessOrder["status"] | "">("");
	const [filters, setFilters] = useState({
		referenceId: "",
		status: "" as BusinessOrder["status"] | "",
	});
	const orders = useResource(JSON.stringify(["orders", offset, filters]), () =>
		api(
			authClient.business.admin.orders({
				query: {
					limit,
					offset,
					referenceId: filters.referenceId || undefined,
					status: filters.status || undefined,
				},
			}),
		),
	);
	const [selected, setSelected] = useState<BusinessOrder | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	function search(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setOffset(0);
		setFilters({ referenceId: reference.trim(), status });
	}
	async function retry(order: BusinessOrder) {
		if (!canRetry(order)) return;
		setPending(true);
		setError("");
		setSuccess("");
		try {
			const updated = await api(
				authClient.business.admin.orders.retry({ orderId: order.id }),
			);
			setSelected(updated);
			setSuccess(
				updated.fulfilledAt
					? "履约已完成，会员与积分已按订单内容发放。"
					: `订单已更新：${orderStatus[updated.status]}。`,
			);
			orders.reload();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setPending(false);
		}
	}
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-xl font-semibold tracking-tight">订单管理</h2>
				<Button
					variant="outline"
					disabled={orders.loading || pending}
					onClick={orders.reload}
				>
					刷新订单
				</Button>
			</div>
			<Card>
				<CardHeader>
					<CardTitle>全部订单</CardTitle>
					<CardDescription>
						查询付款、权益履约和退款记录，处理需要人工复核的订单。
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<form
						onSubmit={search}
						className="flex flex-col gap-3 sm:flex-row sm:items-end"
					>
						<div className="min-w-0 flex-1">
							<Field label="用户 ID" htmlFor="order-reference">
								<Input
									id="order-reference"
									value={reference}
									maxLength={128}
									placeholder="输入完整用户 ID"
									onChange={(event) => setReference(event.target.value)}
								/>
							</Field>
						</div>
						<div className="sm:w-44">
							<Field label="订单状态" htmlFor="order-status">
								<select
									id="order-status"
									className={selectStyle}
									value={status}
									onChange={(event) =>
										setStatus(
											event.target.value as BusinessOrder["status"] | "",
										)
									}
								>
									<option value="">全部状态</option>
									{Object.entries(orderStatus).map(([value, label]) => (
										<option key={value} value={value}>
											{label}
										</option>
									))}
								</select>
							</Field>
						</div>
						<div className="flex gap-2">
							<Button type="submit">筛选</Button>
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									setReference("");
									setStatus("");
									setFilters({ referenceId: "", status: "" });
									setOffset(0);
								}}
							>
								重置
							</Button>
						</div>
					</form>
					<RequestState
						{...orders}
						retry={orders.reload}
						empty={orders.data?.orders.length === 0}
						message="没有符合筛选条件的订单。"
					/>
					{orders.data && orders.data.orders.length > 0 && (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>订单 / 用户</TableHead>
									<TableHead>购买内容</TableHead>
									<TableHead>订单金额</TableHead>
									<TableHead>状态</TableHead>
									<TableHead>创建日期</TableHead>
									<TableHead className="text-right">操作</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{orders.data.orders.map((order) => (
									<TableRow key={order.id}>
										<TableCell>
											<p className="font-medium" title={order.id}>
												{order.id.slice(0, 12)}…
											</p>
											<p
												className="max-w-48 truncate text-xs text-muted-foreground"
												title={order.referenceId}
											>
												{order.referenceId}
											</p>
										</TableCell>
										<TableCell>
											<p className="font-medium">{order.product.name}</p>
											<p className="text-xs text-muted-foreground">
												v{order.product.version} · {order.provider}
												{order.parentOrderId ? " · 续费" : ""}
											</p>
										</TableCell>
										<TableCell className="whitespace-nowrap tabular-nums">
											{money(order.amount, order.currency)}
											{!order.paidAt && (
												<p className="text-xs text-muted-foreground">
													尚未付款
												</p>
											)}
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap gap-1">
												<Badge
													variant={
														order.status === "fulfilled"
															? "default"
															: "secondary"
													}
												>
													{orderStatus[order.status]}
												</Badge>
												{order.reviewRequired && (
													<Badge variant="outline">需人工复核</Badge>
												)}
											</div>
										</TableCell>
										<TableCell className="whitespace-nowrap text-muted-foreground">
											{formatDate(order.createdAt)}
										</TableCell>
										<TableCell className="text-right">
											<Button
												variant="outline"
												size="sm"
												onClick={() => {
													setSelected(order);
													setError("");
													setSuccess("");
												}}
											>
												查看详情<span className="sr-only">{order.id}</span>
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{orders.data && (
						<Pagination
							offset={offset}
							limit={limit}
							total={orders.data.total}
							onChange={setOffset}
						/>
					)}
				</CardContent>
			</Card>
			<Dialog
				open={!!selected}
				onOpenChange={(open) => {
					if (!open && !pending) setSelected(null);
				}}
			>
				<DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>订单详情</DialogTitle>
						<DialogDescription className="break-all">
							{selected?.id}
						</DialogDescription>
					</DialogHeader>
					{selected && (
						<div className="space-y-5">
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant={
										selected.status === "fulfilled" ? "default" : "secondary"
									}
								>
									{orderStatus[selected.status]}
								</Badge>
								<span className="font-semibold tabular-nums">
									{money(selected.amount, selected.currency)}
								</span>
							</div>
							{selected.reviewRequired && (
								<Notice message="此订单需要人工复核。请核对已退款金额、会员状态和积分流水，再决定是否需要人工调整。" />
							)}
							<Notice message={error} />
							<Notice message={success} kind="success" />
							<dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
								{(
									[
										["用户 ID", selected.referenceId],
										["支付渠道", selected.provider],
										["渠道订单号", selected.providerOrderId || "—"],
										["付款编号", selected.paymentId || "—"],
										["创建时间", formatDate(selected.createdAt)],
										["付款期限", formatDate(selected.expiresAt)],
										["已核验付款时间", formatDate(selected.paidAt)],
										["履约完成时间", formatDate(selected.fulfilledAt)],
										["会员开始时间", formatDate(selected.periodStart)],
										["会员结束时间", formatDate(selected.periodEnd)],
										[
											"已核验退款金额",
											money(selected.refundedAmount, selected.currency),
										],
										["原始订单", selected.parentOrderId || "非续费订单"],
									] as const
								).map(([label, value]) => (
									<div key={label}>
										<dt className="text-muted-foreground">{label}</dt>
										<dd className="mt-1 break-all">{value}</dd>
									</div>
								))}
							</dl>
							<div className="space-y-2">
								<h3 className="text-sm font-medium">购买时的套餐快照</h3>
								<p className="text-xs text-muted-foreground">
									价格与权益以这份购买记录为准。
								</p>
								<pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed">
									{JSON.stringify(selected.product, null, 2)}
								</pre>
							</div>
							{canRetry(selected) && (
								<div className="space-y-3 border-t pt-4">
									<p className="text-sm text-muted-foreground">
										付款已确认，但权益尚未全部发放。重试会继续完成履约，不会再次扣款。
									</p>
									<Button
										disabled={pending}
										onClick={() => void retry(selected)}
									>
										{pending ? "正在重试履约…" : "重试履约"}
									</Button>
								</div>
							)}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
