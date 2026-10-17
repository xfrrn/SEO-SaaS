"use client";

import type { TicketStatus } from "@app/auth-sdk/tickets";
import { useState } from "react";
import { Field, Notice, Pagination, RequestState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, useOperation, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

export const ticketLabels: Record<TicketStatus, string> = {
	open: "待处理",
	in_progress: "处理中",
	closed: "已关闭",
};

export function TicketThread({
	ticketId,
	admin,
	onChange,
}: {
	ticketId: string;
	admin: boolean;
	onChange: () => void;
}) {
	const [offset, setOffset] = useState(0);
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const operation = useOperation();
	const scope = admin ? authClient.tickets.admin : authClient.tickets;
	const resource = useResource(`${ticketId}:${offset}:${admin}`, () =>
		api(scope.get({ query: { ticketId, limit: 20, offset } })),
	);
	async function reply() {
		setBusy(true);
		setError("");
		try {
			const payload = {
				action: admin ? "ticket.admin.reply" : "ticket.reply",
				ticketId,
				content: content.trim(),
			};
			await api(
				scope.reply({
					ticketId,
					content: payload.content,
					idempotencyKey: operation.key(payload),
				}),
			);
			operation.reset();
			setContent("");
			setOffset(Math.floor((resource.data?.total ?? 0) / 20) * 20);
			resource.reload();
			onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}
	async function changeStatus(status: TicketStatus) {
		if (!resource.data) return;
		setBusy(true);
		setError("");
		try {
			const payload = {
				action: "ticket.status",
				ticketId,
				status,
				expectedRevision: resource.data.ticket.revision,
			};
			await api(
				authClient.tickets.admin.status({
					ticketId,
					status,
					expectedRevision: payload.expectedRevision,
					idempotencyKey: operation.key(payload),
				}),
			);
			operation.reset();
			resource.reload();
			onChange();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Card className="min-w-0">
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<CardTitle className="break-words">
						{resource.data?.ticket.title ?? "工单详情"}
					</CardTitle>
					<Button
						variant="outline"
						size="sm"
						disabled={busy || resource.loading}
						onClick={resource.reload}
					>
						刷新对话
					</Button>
				</div>
				{resource.data && (
					<CardDescription className="break-all">
						{ticketLabels[resource.data.ticket.status]} ·{" "}
						{formatDate(resource.data.ticket.updatedAt)}
						{admin && ` · 用户 ${resource.data.ticket.userId}`}
					</CardDescription>
				)}
			</CardHeader>
			<CardContent className="space-y-5">
				<RequestState
					loading={resource.loading}
					error={resource.error}
					retry={resource.reload}
				/>
				{resource.data && (
					<>
						{admin && (
							<div
								className="flex flex-wrap gap-2"
								role="group"
								aria-label="工单处理状态"
							>
								{(Object.keys(ticketLabels) as TicketStatus[]).map((status) => (
									<Button
										key={status}
										size="sm"
										variant={
											resource.data?.ticket.status === status
												? "default"
												: "outline"
										}
										aria-pressed={resource.data?.ticket.status === status}
										disabled={
											busy ||
											resource.loading ||
											resource.data?.ticket.status === status
										}
										onClick={() => void changeStatus(status)}
									>
										{ticketLabels[status]}
									</Button>
								))}
							</div>
						)}
						<div className="space-y-2 border-b pb-5">
							<p className="text-sm text-muted-foreground">
								用户提交 · {formatDate(resource.data.ticket.createdAt)}
							</p>
							<p className="whitespace-pre-wrap break-words text-sm leading-6">
								{resource.data.ticket.content}
							</p>
						</div>
						<ol className="space-y-5" aria-label="工单对话">
							{resource.data.entries.map((entry) => (
								<li key={entry.id} className="space-y-2">
									<p className="text-sm font-medium">
										{entry.authorRole === "admin" ? "管理员" : "用户"}
										<span className="ml-2 font-normal text-muted-foreground">
											{formatDate(entry.createdAt)}
										</span>
									</p>
									<p className="whitespace-pre-wrap break-words text-sm leading-6">
										{entry.kind === "status"
											? `处理状态改为${ticketLabels[entry.status!]}`
											: entry.content}
									</p>
								</li>
							))}
						</ol>
						{resource.data.total > 20 && (
							<Pagination
								offset={offset}
								limit={20}
								total={resource.data.total}
								onChange={setOffset}
							/>
						)}
						{resource.data.ticket.status === "closed" ? (
							<p className="text-sm text-muted-foreground">
								工单已关闭，管理员重新打开后可继续回复。
							</p>
						) : (
							<form
								className="space-y-3"
								onSubmit={(event) => {
									event.preventDefault();
									void reply();
								}}
							>
								<Field label="追加回复" htmlFor="ticket-reply">
									<Textarea
										id="ticket-reply"
										value={content}
										onChange={(event) => setContent(event.target.value)}
										maxLength={10_000}
										rows={4}
										required
										disabled={busy}
									/>
								</Field>
								<Button type="submit" disabled={busy || !content.trim()}>
									{busy ? "正在保存…" : "发送回复"}
								</Button>
							</form>
						)}
					</>
				)}
				<Notice message={error} />
			</CardContent>
		</Card>
	);
}
