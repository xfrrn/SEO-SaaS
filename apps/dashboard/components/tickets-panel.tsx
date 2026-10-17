"use client";

import type { TicketStatus } from "@app/auth-sdk/tickets";
import { useState } from "react";
import { Field, Notice, Pagination, RequestState } from "@/components/shared";
import { TicketThread, ticketLabels } from "@/components/ticket-thread";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage, useOperation, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

export function TicketsPanel({ admin = false }: { admin?: boolean }) {
	const [status, setStatus] = useState<TicketStatus | undefined>();
	const [offset, setOffset] = useState(0);
	const [selected, setSelected] = useState("");
	const [creating, setCreating] = useState(false);
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const operation = useOperation();
	const scope = admin ? authClient.tickets.admin : authClient.tickets;
	const resource = useResource(`${admin}:${status}:${offset}`, () =>
		api(scope.list({ query: { status, limit: 20, offset } })),
	);
	async function create() {
		setBusy(true);
		setError("");
		try {
			const payload = {
				action: "ticket.create",
				title: title.trim(),
				content: content.trim(),
			};
			const { ticket } = await api(
				authClient.tickets.create({
					title: payload.title,
					content: payload.content,
					idempotencyKey: operation.key(payload),
				}),
			);
			operation.reset();
			setSelected(ticket.id);
			setCreating(false);
			setTitle("");
			setContent("");
			setOffset(0);
			setStatus(undefined);
			resource.reload();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="space-y-4" aria-label={admin ? "工单管理" : "我的工单"}>
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="text-xl font-semibold">
						{admin ? "用户反馈工单" : "我的工单"}
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{admin
							? "查看反馈、回复用户并更新处理状态。"
							: "提交问题并查看回复，你只能访问自己的工单。"}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={resource.reload}
						disabled={resource.loading}
					>
						刷新工单
					</Button>
					{!admin && (
						<Button
							onClick={() => setCreating((value) => !value)}
							disabled={busy}
						>
							{creating ? "收起表单" : "新建工单"}
						</Button>
					)}
				</div>
			</header>
			{creating && (
				<Card>
					<CardHeader>
						<CardTitle>提交反馈</CardTitle>
						<CardDescription>
							描述发生场景、操作步骤和预期结果，方便我们定位问题。
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							className="space-y-4"
							onSubmit={(event) => {
								event.preventDefault();
								void create();
							}}
						>
							<Field label="工单标题" htmlFor="ticket-title">
								<Input
									id="ticket-title"
									value={title}
									onChange={(event) => setTitle(event.target.value)}
									maxLength={200}
									required
									disabled={busy}
								/>
							</Field>
							<Field label="问题描述" htmlFor="ticket-content">
								<Textarea
									id="ticket-content"
									value={content}
									onChange={(event) => setContent(event.target.value)}
									maxLength={10_000}
									rows={5}
									required
									disabled={busy}
								/>
							</Field>
							<Notice message={error} />
							<Button
								type="submit"
								disabled={busy || !title.trim() || !content.trim()}
							>
								{busy ? "正在提交…" : "提交工单"}
							</Button>
						</form>
					</CardContent>
				</Card>
			)}
			<div
				className="flex flex-wrap gap-2"
				role="group"
				aria-label="筛选工单状态"
			>
				{([undefined, "open", "in_progress", "closed"] as const).map(
					(value) => (
						<Button
							key={value ?? "all"}
							variant={status === value ? "default" : "outline"}
							size="sm"
							aria-pressed={status === value}
							onClick={() => {
								setStatus(value);
								setOffset(0);
							}}
						>
							{value ? ticketLabels[value] : "全部"}
						</Button>
					),
				)}
			</div>
			<div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
				<Card className="min-w-0">
					<CardHeader>
						<CardTitle>工单列表</CardTitle>
						{resource.data && (
							<CardDescription>共 {resource.data.total} 个工单</CardDescription>
						)}
					</CardHeader>
					<CardContent>
						<RequestState
							loading={resource.loading}
							error={resource.error}
							retry={resource.reload}
							empty={resource.data?.tickets.length === 0}
							message={
								admin
									? "暂无符合条件的反馈工单。"
									: "暂无工单，点击“新建工单”提交反馈。"
							}
						/>
						{resource.data && (
							<>
								<ul className="divide-y">
									{resource.data.tickets.map((ticket) => (
										<li key={ticket.id}>
											<button
												type="button"
												aria-pressed={selected === ticket.id}
												className="w-full space-y-2 rounded-md px-2 py-4 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted"
												onClick={() => setSelected(ticket.id)}
											>
												<span className="block break-words text-sm font-medium">
													{ticket.title}
												</span>
												<span className="block text-xs text-muted-foreground">
													{ticketLabels[ticket.status]} ·{" "}
													{formatDate(ticket.updatedAt)}
												</span>
												{admin && (
													<span className="block break-all text-xs text-muted-foreground">
														用户 {ticket.userId}
													</span>
												)}
											</button>
										</li>
									))}
								</ul>
								<Pagination
									offset={offset}
									limit={20}
									total={resource.data.total}
									onChange={setOffset}
								/>
							</>
						)}
					</CardContent>
				</Card>
				{selected ? (
					<TicketThread
						key={selected}
						ticketId={selected}
						admin={admin}
						onChange={resource.reload}
					/>
				) : (
					<p className="py-12 text-center text-sm text-muted-foreground">
						选择工单查看对话与处理进度。
					</p>
				)}
			</div>
		</section>
	);
}
