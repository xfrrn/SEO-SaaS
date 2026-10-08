"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Field, Pagination, RequestState } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

const actions: Record<string, string> = {
	"dashboard.bootstrap": "初始化管理员",
	"order.fulfill": "订单履约",
	"order.refund": "退款权益核对",
	"product.save": "保存套餐",
	"product.publish": "套餐上下架",
	"credits.grant": "发放积分",
	"credits.consume": "扣减积分",
	"membership.adjust": "调整会员",
	"admin.create-user": "创建用户",
	"admin.update-user": "编辑用户",
	"admin.ban-user": "封禁用户",
	"admin.unban-user": "解除封禁",
	"admin.set-role": "修改角色",
	"admin.revoke-user-session": "撤销会话",
	"admin.revoke-user-sessions": "撤销全部会话",
	"admin.remove-user": "删除用户",
	"admin.set-user-password": "修改用户密码",
};
const statuses = {
	started: "操作开始",
	succeeded: "成功",
	failed: "失败",
} as const;

export function AuditPanel() {
	const [filter, setFilter] = useState({ actorId: "", targetId: "" });
	const [offset, setOffset] = useState(0);
	const resource = useResource(JSON.stringify([filter, offset]), () =>
		api(
			authClient.business.admin.audit({
				query: {
					actorId: filter.actorId || undefined,
					targetId: filter.targetId || undefined,
					limit: 20,
					offset,
				},
			}),
		),
	);
	function search(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const data = new FormData(event.currentTarget);
		setFilter({
			actorId: String(data.get("actorId")).trim(),
			targetId: String(data.get("targetId")).trim(),
		});
		setOffset(0);
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>操作审计</CardTitle>
				<CardDescription>
					查看操作人、变更原因与执行结果。记录仅追加保留。
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<form onSubmit={search} className="flex flex-wrap items-end gap-3">
					<Field label="操作人 ID" htmlFor="audit-actor">
						<Input
							id="audit-actor"
							name="actorId"
							placeholder="全部操作人"
							maxLength={128}
						/>
					</Field>
					<Field label="目标 ID" htmlFor="audit-target">
						<Input
							id="audit-target"
							name="targetId"
							placeholder="用户、订单或套餐 ID"
							maxLength={128}
						/>
					</Field>
					<Button type="submit">筛选</Button>
				</form>
				<RequestState
					{...resource}
					retry={resource.reload}
					empty={resource.data?.entries.length === 0}
					message="暂无符合条件的操作记录。"
				/>
				{resource.data && resource.data.entries.length > 0 && (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>时间</TableHead>
								<TableHead>操作人</TableHead>
								<TableHead>操作</TableHead>
								<TableHead>目标</TableHead>
								<TableHead>原因</TableHead>
								<TableHead>结果</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{resource.data.entries.map((entry) => (
								<TableRow key={entry.id}>
									<TableCell className="whitespace-nowrap">
										{formatDate(entry.createdAt)}
									</TableCell>
									<TableCell className="max-w-48 break-all text-xs">
										{entry.actorId === "system" ? "系统" : entry.actorId}
									</TableCell>
									<TableCell className="whitespace-nowrap">
										{actions[entry.action] ?? entry.action}
									</TableCell>
									<TableCell className="max-w-48 break-all text-xs">
										{entry.targetId}
									</TableCell>
									<TableCell className="min-w-40 max-w-72 break-words">
										{entry.reason}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												entry.status === "failed" ? "destructive" : "secondary"
											}
										>
											{statuses[entry.status]}
										</Badge>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				{resource.data && (
					<Pagination
						offset={offset}
						limit={20}
						total={resource.data.total}
						onChange={setOffset}
					/>
				)}
			</CardContent>
		</Card>
	);
}
