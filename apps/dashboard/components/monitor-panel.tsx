"use client";

import type { MonitorDelivery } from "@app/auth-sdk/business";
import { useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, useOperation, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

const statuses = {
	pending: "待发送",
	processing: "发送中",
	sent: "已送达",
	failed: "失败",
	expired: "已过补发期",
};
const types = { signup_confirmed: "注册", payment_confirmed: "付款" };
const errors: Record<string, string> = {
	collector_network_error: "连接失败或超时",
	collector_http_error: "接收服务拒绝请求",
	collector_invalid_receipt: "接收回执不符合约定",
	collector_invalid_record: "事件不符合接收协议",
	monitor_policy_changed: "当前站点配置不再允许这份归因",
	monitor_delivery_error: "投递未完成",
	monitor_retry_window_expired: "已超过补发期限",
	monitor_attempts_exhausted: "自动尝试次数已用尽",
};
const selectStyle =
	"h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
type Event = Omit<MonitorDelivery, "leaseToken" | "eventKey">;

/** Present stored browser clues as analytics, without implying verified identity. */
export function MonitorAttribution(query: {
	userId?: string;
	orderId?: string;
}) {
	const result = useResource(
		JSON.stringify(["attribution", query]),
		async () => {
			const status = await api(authClient.business.admin.monitor.status());
			return status.enabled
				? {
						enabled: true,
						...(await api(
							authClient.business.admin.monitor.attribution({ query }),
						)),
					}
				: { enabled: false, attribution: null };
		},
	);
	return (
		<section className="space-y-2 border-t pt-4">
			<h3 className="text-sm font-medium">
				{query.orderId ? "下单归因" : "注册归因"}
			</h3>
			<RequestState {...result} retry={result.reload} />
			{result.data &&
				(!result.data.enabled ? (
					<p className="text-sm text-muted-foreground">
						监控已关闭，已有记录保留。
					</p>
				) : result.data.attribution ? (
					<>
						<p className="text-xs text-muted-foreground">
							浏览器提供的访问线索，仅用于来源分析。
						</p>
						<pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
							{JSON.stringify(result.data.attribution, null, 2)}
						</pre>
					</>
				) : (
					<p className="text-sm text-muted-foreground">未保存归因线索。</p>
				))}
		</section>
	);
}

export function MonitorPanel() {
	const status = useResource("monitor-status", () =>
		api(authClient.business.admin.monitor.status()),
	);
	const [success, setSuccess] = useState("");
	const data = status.data;
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-xl font-semibold tracking-tight">监控</h2>
				<Button variant="outline" onClick={status.reload}>
					刷新状态
				</Button>
			</div>
			<Notice message={success} kind="success" />
			<Card>
				<CardHeader>
					<CardTitle>接入状态</CardTitle>
					<CardDescription>查看本站的注册、付款投递情况。</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<RequestState {...status} retry={status.reload} />
					{data &&
						(!data.enabled ? (
							<p className="text-sm text-muted-foreground">
								监控已关闭，暂停采集与投递，已有记录保留。
							</p>
						) : (
							<>
								<dl className="grid gap-4 text-sm sm:grid-cols-2">
									{[
										["站点", data.siteId],
										["环境", data.environment],
										["接收地址", data.endpoint],
										[
											"写入凭证",
											data.credentialConfigured ? "已配置" : "未配置",
										],
										[
											"最近成功",
											data.lastDeliveredAt
												? formatDate(data.lastDeliveredAt)
												: "暂无成功投递",
										],
										[
											"补发期限",
											`首次尝试后 ${data.retryWindowMs / 86_400_000} 天`,
										],
									].map(([label, value]) => (
										<div key={label}>
											<dt className="text-muted-foreground">{label}</dt>
											<dd className="mt-1 break-all">{value}</dd>
										</div>
									))}
								</dl>
								<p className="text-xs text-muted-foreground">
									配置已加载。送达状态以接收服务的有效回执为准。
								</p>
								<div className="flex flex-wrap gap-2">
									{Object.entries(statuses).map(([key, label]) => (
										<Badge key={key} variant="secondary">
											{label} {data.counts[key as keyof typeof statuses]}
										</Badge>
									))}
								</div>
							</>
						))}
				</CardContent>
			</Card>
			{data?.enabled && (
				<MonitorEvents
					retryWindowMs={data.retryWindowMs}
					onChanged={() => {
						setSuccess("补发已安排，后台任务将继续投递。");
						status.reload();
					}}
				/>
			)}
		</div>
	);
}

function MonitorEvents({
	retryWindowMs,
	onChanged,
}: {
	retryWindowMs: number;
	onChanged: () => void;
}) {
	const [offset, setOffset] = useState(0);
	const [filters, setFilters] = useState({
		type: "" as MonitorDelivery["eventType"] | "",
		status: "" as MonitorDelivery["status"] | "",
		userId: "",
		orderId: "",
	});
	const limit = 20;
	const result = useResource(JSON.stringify([filters, offset]), () =>
		api(
			authClient.business.admin.monitor.events({
				query: {
					limit,
					offset,
					type: filters.type || undefined,
					status: filters.status || undefined,
					userId: filters.userId || undefined,
					orderId: filters.orderId || undefined,
				},
			}),
		),
	);
	const [selected, setSelected] = useState<Event | null>(null);
	const [reason, setReason] = useState("");
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const operation = useOperation();
	const retryable =
		selected?.status === "failed" &&
		(!selected.firstAttemptAt ||
			Date.now() - new Date(selected.firstAttemptAt).getTime() < retryWindowMs);
	return (
		<Card>
			<CardHeader>
				<CardTitle>投递记录</CardTitle>
				<CardDescription>补发只重送已保存的监控事件。</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<form
					className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
					onSubmit={(event) => {
						event.preventDefault();
						const form = new FormData(event.currentTarget);
						setOffset(0);
						setFilters({
							type: String(form.get("type")) as typeof filters.type,
							status: String(form.get("status")) as typeof filters.status,
							userId: String(form.get("userId")).trim(),
							orderId: String(form.get("orderId")).trim(),
						});
					}}
				>
					<Field label="事件类型" htmlFor="monitor-type">
						<select id="monitor-type" name="type" className={selectStyle}>
							<option value="">全部</option>
							{Object.entries(types).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</Field>
					<Field label="投递状态" htmlFor="monitor-status">
						<select id="monitor-status" name="status" className={selectStyle}>
							<option value="">全部</option>
							{Object.entries(statuses).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</Field>
					<Field label="用户 ID" htmlFor="monitor-user">
						<Input id="monitor-user" name="userId" maxLength={128} />
					</Field>
					<Field label="订单 ID" htmlFor="monitor-order">
						<Input id="monitor-order" name="orderId" maxLength={128} />
					</Field>
					<div className="flex items-end gap-2">
						<Button type="submit">筛选</Button>
						<Button type="button" variant="outline" onClick={result.reload}>
							刷新记录
						</Button>
					</div>
				</form>
				<RequestState
					{...result}
					retry={result.reload}
					empty={result.data?.events.length === 0}
					message="没有符合筛选条件的投递记录。"
				/>
				{!!result.data?.events.length && (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>事件 / 用户 / 订单</TableHead>
								<TableHead>业务时间</TableHead>
								<TableHead>状态</TableHead>
								<TableHead>尝试</TableHead>
								<TableHead>失败原因</TableHead>
								<TableHead>操作</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{result.data.events.map((event) => (
								<TableRow key={event.eventId}>
									<TableCell className="max-w-64 break-all">
										<p>{types[event.eventType]}</p>
										<p className="text-xs text-muted-foreground">
											{event.userId}
										</p>
										{event.orderId && (
											<p className="text-xs text-muted-foreground">
												{event.orderId}
											</p>
										)}
									</TableCell>
									<TableCell className="whitespace-nowrap">
										{formatDate(event.payload.record.occurredAt)}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												event.status === "sent" ? "default" : "secondary"
											}
										>
											{statuses[event.status]}
										</Badge>
									</TableCell>
									<TableCell>{event.attempts}</TableCell>
									<TableCell>
										{event.lastError
											? (errors[event.lastError] ?? "投递未完成")
											: "—"}
										{event.lastHttpStatus ? ` (${event.lastHttpStatus})` : ""}
									</TableCell>
									<TableCell>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												setSelected(event);
												setReason("");
												setError("");
											}}
										>
											详情
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				{result.data && (
					<Pagination
						offset={offset}
						limit={limit}
						total={result.data.total}
						onChange={setOffset}
					/>
				)}
				<Dialog
					open={!!selected}
					onOpenChange={(open) => {
						if (!open && !busy.current) setSelected(null);
					}}
				>
					<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
						<DialogHeader>
							<DialogTitle>投递详情</DialogTitle>
							<DialogDescription>
								原始业务时间和事件内容在补发时保持不变。
							</DialogDescription>
						</DialogHeader>
						{selected && (
							<div className="space-y-4">
								<dl className="space-y-2 text-sm">
									<div>
										<dt>事件 ID</dt>
										<dd className="break-all text-muted-foreground">
											{selected.eventId}
										</dd>
									</div>
									<div>
										<dt>状态 / 尝试次数</dt>
										<dd>
											{statuses[selected.status]} / {selected.attempts}
										</dd>
									</div>
									<div>
										<dt>下次执行</dt>
										<dd>{formatDate(selected.nextAttemptAt)}</dd>
									</div>
									<div>
										<dt>首次尝试</dt>
										<dd>{formatDate(selected.firstAttemptAt)}</dd>
									</div>
								</dl>
								{selected.lastError && (
									<p className="text-sm">
										{errors[selected.lastError] ?? "投递未完成"}
										{selected.lastHttpStatus
											? ` (${selected.lastHttpStatus})`
											: ""}
									</p>
								)}
								<pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
									{JSON.stringify(selected.payload, null, 2)}
								</pre>
								{retryable ? (
									<form
										className="space-y-3"
										onSubmit={async (event) => {
											event.preventDefault();
											if (busy.current) return;
											busy.current = true;
											setPending(true);
											setError("");
											try {
												const body = {
													eventId: selected.eventId,
													reason: reason.trim(),
												};
												await api(
													authClient.business.admin.monitor.retry({
														...body,
														operationId: operation.key({
															action: "monitor.retry",
															...body,
														}),
													}),
												);
												operation.reset();
												setSelected(null);
												result.reload();
												onChanged();
											} catch (cause) {
												setError(errorMessage(cause));
											} finally {
												busy.current = false;
												setPending(false);
											}
										}}
									>
										<Field label="补发原因" htmlFor="monitor-reason">
											<Textarea
												id="monitor-reason"
												required
												maxLength={500}
												disabled={pending}
												value={reason}
												onChange={(event) => setReason(event.target.value)}
											/>
										</Field>
										<Notice message={error} />
										<Button type="submit" disabled={pending || !reason.trim()}>
											{pending ? "提交中…" : "安排补发"}
										</Button>
									</form>
								) : (
									<p className="text-sm text-muted-foreground">
										仅失败且仍在补发期限内的事件可以补发。
									</p>
								)}
							</div>
						)}
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	);
}
