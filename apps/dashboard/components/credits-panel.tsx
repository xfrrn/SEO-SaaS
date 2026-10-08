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
import { UserPicker } from "@/components/user-picker";
import { api, errorMessage, useOperation, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

export function CreditsPanel() {
	const [user, setUser] = useState<SelectedUser | null>(null);
	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle>积分</CardTitle>
					<CardDescription>
						先选择用户，再查看可用余额、发放批次与消费流水。
					</CardDescription>
				</CardHeader>
				<CardContent>
					<UserPicker value={user} onChange={setUser} />
				</CardContent>
			</Card>
			{user && <CreditAccount key={user.id} user={user} />}
		</div>
	);
}

function CreditAccount({ user }: { user: SelectedUser }) {
	const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
	const [page, setPage] = useState(0);
	const [action, setAction] = useState<"grant" | "consume" | null>(null);
	const [notice, setNotice] = useState("");
	const cursor = cursors[page];
	const result = useResource(`${user.id}:${cursor ?? "first"}`, async () => {
		const [customer, ledger] = await Promise.all([
			api(
				authClient.business.admin.customer({ query: { referenceId: user.id } }),
			),
			api(
				authClient.business.admin.credits.ledger({
					query: {
						referenceId: user.id,
						limit: 20,
						...(cursor ? { cursor } : {}),
					},
				}),
			),
		]);
		return { balance: customer.credits.balance, ...ledger };
	});
	const data = result.data;
	const labels = {
		grant: "发放",
		consume: "消费",
		expire: "到期",
		revoke: "回收",
	} as const;
	return (
		<>
			<Notice message={notice} kind="success" />
			<Card>
				<CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-2">
						<CardDescription>当前可用积分</CardDescription>
						<CardTitle className="tabular-nums">
							{result.loading
								? "加载中…"
								: data
									? data.balance.toLocaleString()
									: "—"}
						</CardTitle>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							disabled={result.loading}
							onClick={result.reload}
						>
							刷新
						</Button>
						<Button
							variant="outline"
							disabled={!data || result.loading || data.balance === 0}
							onClick={() => {
								setNotice("");
								setAction("consume");
							}}
						>
							扣减积分
						</Button>
						<Button
							disabled={!data || result.loading}
							onClick={() => {
								setNotice("");
								setAction("grant");
							}}
						>
							发放积分
						</Button>
					</div>
				</CardHeader>
				<CardContent>
					<p className="mb-4 text-sm text-muted-foreground">
						已到期的批次不计入可用余额。消费优先扣除最早到期的积分。
					</p>
					<RequestState
						loading={result.loading}
						error={result.error}
						retry={result.reload}
						empty={data?.entries.length === 0}
						message="该用户还没有积分流水。发放积分后会在这里记录。"
					/>
					{!result.loading &&
						!result.error &&
						data &&
						data.entries.length > 0 && (
							<>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>时间</TableHead>
											<TableHead>类型与原因</TableHead>
											<TableHead className="text-right">变动</TableHead>
											<TableHead className="text-right">当时余额</TableHead>
											<TableHead>到期时间</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.entries.map((entry) => (
											<TableRow key={entry.id}>
												<TableCell className="whitespace-nowrap">
													{formatDate(entry.createdAt)}
												</TableCell>
												<TableCell>
													<Badge variant="outline">
														{entry.kind
															? labels[entry.kind]
															: entry.amount > 0
																? "发放"
																: "消费"}
													</Badge>
													<p className="mt-1 max-w-xs break-words text-sm text-muted-foreground">
														{entry.reason || "未填写原因"}
													</p>
													{entry.source && (
														<p className="mt-1 max-w-xs break-all text-xs text-muted-foreground">
															来源：{entry.source}
														</p>
													)}
												</TableCell>
												<TableCell className="text-right font-medium tabular-nums">
													{entry.amount > 0 ? "+" : ""}
													{entry.amount.toLocaleString()}
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{entry.balance.toLocaleString()}
												</TableCell>
												<TableCell className="whitespace-nowrap text-muted-foreground">
													{entry.expiresAt
														? formatDate(entry.expiresAt)
														: entry.kind === "grant" ||
																(!entry.kind && entry.amount > 0)
															? "永久有效"
															: "—"}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
								<Pagination
									offset={page * 20}
									limit={20}
									hasMore={data.nextCursor !== null}
									onChange={(offset) => {
										const nextPage = offset / 20;
										if (nextPage > page && data.nextCursor !== null)
											setCursors([
												...cursors.slice(0, page + 1),
												data.nextCursor,
											]);
										setPage(nextPage);
									}}
								/>
							</>
						)}
				</CardContent>
			</Card>
			{action && (
				<CreditAdjustment
					user={user}
					action={action}
					balance={data?.balance ?? 0}
					onClose={() => setAction(null)}
					onDone={() => {
						setNotice(action === "grant" ? "积分已发放。" : "积分已扣减。");
						setAction(null);
						setCursors([undefined]);
						setPage(0);
						result.reload();
					}}
				/>
			)}
		</>
	);
}

function CreditAdjustment({
	user,
	action,
	balance,
	onClose,
	onDone,
}: {
	user: SelectedUser;
	action: "grant" | "consume";
	balance: number;
	onClose: () => void;
	onDone: () => void;
}) {
	const [amount, setAmount] = useState("");
	const [expiresAt, setExpiresAt] = useState("");
	const [reason, setReason] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const [error, setError] = useState("");
	const operation = useOperation();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy.current) onClose();
			}}
		>
			<DialogContent className="max-h-[90dvh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{action === "grant" ? "发放积分" : "扣减积分"}
					</DialogTitle>
					<DialogDescription>
						操作账户：{user.name}（{user.email}）。
						{action === "consume"
							? "确认后直接扣减可用余额，请核对数量。"
							: "新发放的积分将作为独立批次记录。"}
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy.current) return;
						setError("");
						try {
							const count = Number(amount);
							if (!Number.isSafeInteger(count) || count <= 0)
								throw new Error("积分数量必须为正整数。");
							if (action === "consume" && count > balance)
								throw new Error("扣减数量超过当前可用余额，请刷新后核对。");
							const expiry =
								action === "grant" && expiresAt
									? new Date(expiresAt)
									: undefined;
							if (expiry && !Number.isFinite(expiry.getTime()))
								throw new Error("请输入有效的到期时间。");
							const payload = {
								referenceId: user.id,
								action,
								amount: count,
								reason: reason.trim(),
								...(expiry ? { expiresAt: expiry.toISOString() } : {}),
							};
							busy.current = true;
							setPending(true);
							await api(
								authClient.business.admin.credits.adjust({
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
					<fieldset disabled={pending} className="space-y-4">
						<Field
							label="积分数量"
							htmlFor="credits-amount"
							hint={
								action === "consume"
									? `当前可用 ${balance.toLocaleString()} 积分。`
									: "仅支持正整数。"
							}
						>
							<Input
								id="credits-amount"
								type="number"
								inputMode="numeric"
								min={1}
								step={1}
								max={action === "consume" ? balance : Number.MAX_SAFE_INTEGER}
								required
								value={amount}
								onChange={(event) => setAmount(event.target.value)}
							/>
						</Field>
						{action === "grant" && (
							<Field
								label="到期时间（可选）"
								htmlFor="credits-expiry"
								hint="留空永久有效；使用当前设备时区。已到期的积分不增加可用余额。"
							>
								<Input
									id="credits-expiry"
									type="datetime-local"
									value={expiresAt}
									onChange={(event) => setExpiresAt(event.target.value)}
								/>
							</Field>
						)}
						<Field label="操作原因" htmlFor="credits-reason">
							<Textarea
								id="credits-reason"
								required
								maxLength={500}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
								placeholder="说明本次补发或扣减的原因"
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
							variant={action === "consume" ? "destructive" : "default"}
							disabled={pending || !reason.trim() || !amount}
						>
							{pending
								? "处理中…"
								: action === "grant"
									? "确认发放"
									: "确认扣减"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
