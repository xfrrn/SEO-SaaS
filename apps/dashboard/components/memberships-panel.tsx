"use client";

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
	DialogFooter,
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
import type { SelectedUser } from "@/components/user-picker";
import { selectClassName, UserPicker } from "@/components/user-picker";
import { api, errorMessage, useOperation, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate, localDateInput } from "@/lib/format";

type Membership = NonNullable<
	Awaited<ReturnType<typeof authClient.business.admin.subscriptions>>["data"]
>["subscriptions"][number];
type Product = NonNullable<
	Awaited<ReturnType<typeof authClient.business.admin.products>>["data"]
>[number];
const statuses = {
	active: "已开通",
	canceled: "已取消",
	incomplete: "待完成",
	incomplete_expired: "未完成已过期",
	past_due: "付款逾期",
	paused: "已暂停",
	trialing: "试用中",
	unpaid: "未付款",
} as const;

function stateLabel(item: Membership) {
	if (item.status === "active" || item.status === "trialing") {
		if (!item.periodStart || !item.periodEnd) return "有效期未设置";
		if (new Date(item.periodEnd).getTime() <= Date.now()) return "已到期";
		if (new Date(item.periodStart).getTime() > Date.now()) return "待生效";
		if (item.endedAt && new Date(item.endedAt).getTime() <= Date.now())
			return "已结束";
		if (item.cancelAt && new Date(item.cancelAt).getTime() <= Date.now())
			return "已取消";
		return item.status === "trialing" ? "试用中" : "生效中";
	}
	return statuses[item.status as keyof typeof statuses] ?? "未知状态";
}

export function MembershipsPanel() {
	const [status, setStatus] = useState<Membership["status"] | "">("");
	const [reference, setReference] = useState("");
	const [filter, setFilter] = useState({ status, reference: "" });
	const [offset, setOffset] = useState(0);
	const [editor, setEditor] = useState<{
		membership?: Membership;
		cancel?: boolean;
	} | null>(null);
	const [notice, setNotice] = useState("");
	const result = useResource(JSON.stringify([filter, offset]), () =>
		api(
			authClient.business.admin.subscriptions({
				query: {
					limit: 20,
					offset,
					...(filter.status ? { status: filter.status } : {}),
					...(filter.reference ? { referenceId: filter.reference } : {}),
				},
			}),
		),
	);
	return (
		<div className="space-y-4">
			<Notice message={notice} kind="success" />
			<Card>
				<CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-1.5">
						<CardTitle>会员</CardTitle>
						<CardDescription>
							查看会员有效期，按商品权益开通或调整。
						</CardDescription>
					</div>
					<Button
						onClick={() => {
							setNotice("");
							setEditor({});
						}}
					>
						开通会员
					</Button>
				</CardHeader>
				<CardContent>
					<form
						className="mb-5 grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end"
						onSubmit={(event) => {
							event.preventDefault();
							setOffset(0);
							setFilter({ status, reference: reference.trim() });
						}}
					>
						<Field label="记录状态" htmlFor="memberships-status">
							<select
								id="memberships-status"
								className={selectClassName}
								value={status}
								onChange={(event) =>
									setStatus(event.target.value as Membership["status"] | "")
								}
							>
								<option value="">全部状态</option>
								{Object.entries(statuses).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</Field>
						<Field label="用户 ID" htmlFor="memberships-reference">
							<Input
								id="memberships-reference"
								value={reference}
								placeholder="输入用户 ID，留空查看全部"
								onChange={(event) => setReference(event.target.value)}
							/>
						</Field>
						<Button type="submit" variant="outline">
							筛选
						</Button>
					</form>
					<RequestState
						loading={result.loading}
						error={result.error}
						retry={result.reload}
						empty={result.data?.subscriptions.length === 0}
						message="没有匹配的会员记录。可调整筛选条件，或为用户开通会员。"
					/>
					{!result.loading &&
						!result.error &&
						result.data &&
						result.data.subscriptions.length > 0 && (
							<>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>用户与套餐</TableHead>
											<TableHead>当前状态</TableHead>
											<TableHead>有效期</TableHead>
											<TableHead>来源</TableHead>
											<TableHead className="text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{result.data.subscriptions.map((item) => {
											const editable =
												item.provider === "business" &&
												item.plan.startsWith("product:") &&
												item.revision != null &&
												item.revision < Number.MAX_SAFE_INTEGER &&
												!!item.periodStart &&
												!!item.periodEnd;
											return (
												<TableRow key={item.id}>
													<TableCell>
														<p className="min-w-48 max-w-xs break-all text-sm font-medium">
															{item.referenceId}
														</p>
														<p className="mt-1 max-w-xs break-all text-xs text-muted-foreground">
															{item.plan}
														</p>
													</TableCell>
													<TableCell>
														<Badge variant="outline">{stateLabel(item)}</Badge>
													</TableCell>
													<TableCell className="whitespace-nowrap text-sm">
														<p>{formatDate(item.periodStart)}</p>
														<p className="mt-1 text-muted-foreground">
															至 {formatDate(item.periodEnd)}
														</p>
													</TableCell>
													<TableCell>
														<p>{item.provider || "未记录"}</p>
														{item.provider !== "business" && (
															<p className="mt-1 text-xs text-muted-foreground">
																由支付渠道管理
															</p>
														)}
													</TableCell>
													<TableCell className="text-right">
														{editable ? (
															<div className="flex justify-end gap-1">
																<Button
																	variant="ghost"
																	size="sm"
																	onClick={() =>
																		setEditor({ membership: item })
																	}
																>
																	编辑
																</Button>
																{item.status !== "canceled" && (
																	<Button
																		variant="ghost"
																		size="sm"
																		onClick={() =>
																			setEditor({
																				membership: item,
																				cancel: true,
																			})
																		}
																	>
																		取消会员
																	</Button>
																)}
															</div>
														) : (
															<span className="text-sm text-muted-foreground">
																只读
															</span>
														)}
													</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
								<Pagination
									offset={offset}
									limit={20}
									total={result.data.total}
									onChange={setOffset}
								/>
							</>
						)}
				</CardContent>
			</Card>
			{editor && (
				<MembershipEditor
					membership={editor.membership}
					cancel={editor.cancel}
					onClose={() => setEditor(null)}
					onDone={() => {
						setNotice(
							editor.cancel
								? "会员已取消。"
								: editor.membership
									? "会员已更新。"
									: "会员已开通。",
						);
						setEditor(null);
						result.reload();
					}}
				/>
			)}
		</div>
	);
}

function MembershipEditor({
	membership,
	cancel = false,
	onClose,
	onDone,
}: {
	membership?: Membership;
	cancel?: boolean;
	onClose: () => void;
	onDone: () => void;
}) {
	const [user, setUser] = useState<SelectedUser | null>(null);
	const [productId, setProductId] = useState(
		membership?.plan.startsWith("product:")
			? membership.plan.slice("product:".length)
			: "",
	);
	const [start, setStart] = useState(
		membership?.periodStart
			? localDateInput(membership.periodStart)
			: localDateInput(new Date()),
	);
	const [end, setEnd] = useState(
		membership?.periodEnd ? localDateInput(membership.periodEnd) : "",
	);
	const [status, setStatus] = useState<"active" | "canceled">(
		cancel || membership?.status === "canceled" ? "canceled" : "active",
	);
	const [reason, setReason] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const [error, setError] = useState("");
	const operation = useOperation();
	const products = useResource(
		membership ? "existing-membership" : "membership-products",
		async () => {
			if (membership) return [] as Product[];
			const items: Product[] = [];
			for (let offset = 0; ; offset += 100) {
				const page = await api(
					authClient.business.admin.products({ query: { limit: 100, offset } }),
				);
				items.push(...page.filter((product) => product.type !== "credits"));
				if (page.length < 100) return items;
			}
		},
	);
	function absolute(value: string, original?: Date | string) {
		return original && value === localDateInput(original)
			? new Date(original).toISOString()
			: new Date(value).toISOString();
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy.current) onClose();
			}}
		>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{cancel ? "取消会员" : membership ? "编辑会员" : "开通会员"}
					</DialogTitle>
					<DialogDescription>
						{cancel
							? "确认后该笔会员权益停止生效。已发放积分不会随之清空。"
							: membership
								? "修改这笔会员的绝对有效期，保留原商品版本。"
								: "选择用户和会员商品。此操作只开通会员，不赠送积分。"}
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy.current) return;
						setError("");
						try {
							const referenceId = membership?.referenceId ?? user?.id;
							if (!referenceId || !productId)
								throw new Error("请选择用户和会员商品。");
							const periodStart =
								cancel && membership?.periodStart
									? new Date(membership.periodStart).toISOString()
									: absolute(start, membership?.periodStart);
							const periodEnd =
								cancel && membership?.periodEnd
									? new Date(membership.periodEnd).toISOString()
									: absolute(end, membership?.periodEnd);
							if (new Date(periodStart) >= new Date(periodEnd))
								throw new Error("结束时间必须晚于开始时间。");
							const payload = {
								referenceId,
								productId,
								status: cancel ? ("canceled" as const) : status,
								periodStart,
								periodEnd,
								reason: reason.trim(),
								...(membership
									? {
											subscriptionId: membership.id,
											expectedRevision: membership.revision ?? undefined,
										}
									: {}),
							};
							busy.current = true;
							setPending(true);
							await api(
								authClient.business.admin.membership.adjust({
									...payload,
									operationId: operation.key(payload),
								}),
							);
							operation.reset();
							onDone();
						} catch (cause) {
							setError(errorMessage(cause));
						} finally {
							busy.current = false;
							setPending(false);
						}
					}}
				>
					<fieldset className="space-y-4" disabled={pending}>
						{membership ? (
							<div className="space-y-1 rounded-md border p-3 text-sm">
								<p className="break-all">用户：{membership.referenceId}</p>
								<p className="break-all text-muted-foreground">
									原商品版本：{productId}
								</p>
							</div>
						) : (
							<>
								<UserPicker
									value={user}
									onChange={setUser}
									disabled={pending}
								/>
								<RequestState
									loading={products.loading}
									error={products.error}
									retry={products.reload}
									empty={products.data?.length === 0}
									message="尚无会员商品。请先在商品目录创建纯会员或组合商品。"
								/>
								{products.data && products.data.length > 0 && (
									<Field label="会员商品" htmlFor="membership-product">
										<select
											id="membership-product"
											className={selectClassName}
											required
											value={productId}
											onChange={(event) => {
												const value = event.target.value;
												setProductId(value);
												const product = products.data?.find(
													(item) => item.id === value,
												);
												if (product?.membershipDays && start)
													setEnd(
														localDateInput(
															new Date(
																new Date(start).getTime() +
																	product.membershipDays * 86_400_000,
															),
														),
													);
											}}
										>
											<option value="">选择一个商品</option>
											{products.data.map((product) => (
												<option key={product.id} value={product.id}>
													{product.name} · v{product.version}
													{product.published ? "" : " · 已下架"}
												</option>
											))}
										</select>
									</Field>
								)}
							</>
						)}
						<div className="grid gap-4 sm:grid-cols-2">
							<Field
								label="开始时间"
								htmlFor="membership-start"
								hint="使用当前设备时区。"
							>
								<Input
									id="membership-start"
									type="datetime-local"
									required
									disabled={cancel}
									value={start}
									onChange={(event) => setStart(event.target.value)}
								/>
							</Field>
							<Field label="结束时间" htmlFor="membership-end">
								<Input
									id="membership-end"
									type="datetime-local"
									required
									disabled={cancel}
									value={end}
									onChange={(event) => setEnd(event.target.value)}
								/>
							</Field>
						</div>
						{membership && !cancel && (
							<Field label="会员状态" htmlFor="membership-edit-status">
								<select
									id="membership-edit-status"
									className={selectClassName}
									value={status}
									onChange={(event) =>
										setStatus(
											event.target.value === "canceled" ? "canceled" : "active",
										)
									}
								>
									<option value="active">开通</option>
									<option value="canceled">取消</option>
								</select>
							</Field>
						)}
						<Field label="操作原因" htmlFor="membership-reason">
							<Textarea
								id="membership-reason"
								required
								maxLength={500}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
								placeholder="记录开通、延期或取消的原因"
							/>
						</Field>
					</fieldset>
					<Notice message={error} />
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={onClose}
						>
							返回
						</Button>
						<Button
							type="submit"
							variant={cancel ? "destructive" : "default"}
							disabled={
								pending ||
								!reason.trim() ||
								!productId ||
								(!membership && !user)
							}
						>
							{pending
								? "保存中…"
								: cancel
									? "确认取消会员"
									: membership
										? "保存修改"
										: "确认开通"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
