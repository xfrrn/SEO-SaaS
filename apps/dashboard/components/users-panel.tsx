"use client";

import { useRef, useState } from "react";
import { MonitorAttribution } from "@/components/monitor-panel";
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
import { selectClassName } from "@/components/user-picker";
import { api, errorMessage, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

type User = NonNullable<
	Awaited<ReturnType<typeof authClient.admin.listUsers>>["data"]
>["users"][number];
type UserSession = NonNullable<
	Awaited<ReturnType<typeof authClient.admin.listUserSessions>>["data"]
>["sessions"][number];
type Action =
	| { kind: "ban" | "unban" | "role"; user: User }
	| { kind: "revoke"; user: User; session: UserSession };

export function UsersPanel() {
	const [field, setField] = useState<"email" | "name">("email");
	const [text, setText] = useState("");
	const [search, setSearch] = useState({ field, text: "" });
	const [offset, setOffset] = useState(0);
	const [editor, setEditor] = useState<{ user?: User } | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [action, setAction] = useState<Action | null>(null);
	const [notice, setNotice] = useState("");
	const [version, setVersion] = useState(0);
	const result = useResource(JSON.stringify([search, offset, version]), () =>
		api(
			authClient.admin.listUsers({
				query: {
					limit: 20,
					offset,
					...(search.text
						? {
								searchField: search.field,
								searchValue: search.text,
								searchOperator: "contains" as const,
							}
						: {}),
				},
			}),
		),
	);
	function changed(message: string) {
		setNotice(message);
		setVersion((value) => value + 1);
	}
	return (
		<div className="space-y-4">
			<Notice message={notice} kind="success" />
			<Card>
				<CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-1.5">
						<CardTitle>用户</CardTitle>
						<CardDescription>
							查找账户，管理资料、角色和登录会话。
						</CardDescription>
					</div>
					<Button
						onClick={() => {
							setNotice("");
							setEditor({});
						}}
					>
						新建用户
					</Button>
				</CardHeader>
				<CardContent>
					<form
						className="mb-5 grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end"
						onSubmit={(event) => {
							event.preventDefault();
							setOffset(0);
							setSearch({ field, text: text.trim() });
						}}
					>
						<Field label="搜索字段" htmlFor="users-field">
							<select
								id="users-field"
								className={selectClassName}
								value={field}
								onChange={(event) =>
									setField(event.target.value === "name" ? "name" : "email")
								}
							>
								<option value="email">邮箱</option>
								<option value="name">姓名</option>
							</select>
						</Field>
						<Field label="搜索用户" htmlFor="users-search">
							<Input
								id="users-search"
								placeholder="输入邮箱或姓名，留空显示全部"
								value={text}
								onChange={(event) => setText(event.target.value)}
							/>
						</Field>
						<Button type="submit" variant="outline">
							搜索
						</Button>
					</form>
					<RequestState
						loading={result.loading}
						error={result.error}
						retry={result.reload}
						empty={result.data?.users.length === 0}
						message="没有匹配的用户。调整搜索条件，或新建一个账户。"
					/>
					{!result.loading &&
						!result.error &&
						result.data &&
						result.data.users.length > 0 && (
							<>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>用户</TableHead>
											<TableHead>角色</TableHead>
											<TableHead>状态</TableHead>
											<TableHead>注册时间</TableHead>
											<TableHead className="text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{result.data.users.map((user) => (
											<TableRow key={user.id}>
												<TableCell>
													<p className="font-medium">{user.name}</p>
													<p className="break-all text-sm text-muted-foreground">
														{user.email}
													</p>
												</TableCell>
												<TableCell>
													<Badge variant="outline">{user.role || "user"}</Badge>
												</TableCell>
												<TableCell>
													<Badge
														variant={user.banned ? "destructive" : "secondary"}
													>
														{user.banned ? "已封禁" : "正常"}
													</Badge>
												</TableCell>
												<TableCell className="whitespace-nowrap text-muted-foreground">
													{formatDate(user.createdAt)}
												</TableCell>
												<TableCell>
													<div className="flex justify-end gap-1">
														<Button
															variant="ghost"
															size="sm"
															onClick={() => setSelected(user.id)}
														>
															详情
														</Button>
														<Button
															variant="ghost"
															size="sm"
															onClick={() => setEditor({ user })}
														>
															编辑
														</Button>
													</div>
												</TableCell>
											</TableRow>
										))}
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
			{selected && (
				<UserDetails
					key={selected}
					userId={selected}
					version={version}
					onClose={() => setSelected(null)}
					onEdit={(user) => setEditor({ user })}
					onAction={setAction}
				/>
			)}
			{editor && (
				<UserEditor
					user={editor.user}
					onClose={() => setEditor(null)}
					onDone={(message) => {
						setEditor(null);
						changed(message);
					}}
				/>
			)}
			{action && (
				<UserAction
					action={action}
					onClose={() => setAction(null)}
					onDone={(message) => {
						setAction(null);
						changed(message);
					}}
				/>
			)}
		</div>
	);
}

function UserDetails({
	userId,
	version,
	onClose,
	onEdit,
	onAction,
}: {
	userId: string;
	version: number;
	onClose: () => void;
	onEdit: (user: User) => void;
	onAction: (action: Action) => void;
}) {
	const result = useResource(`${userId}:${version}`, async () => {
		const [user, sessions] = await Promise.all([
			api(authClient.admin.getUser({ query: { id: userId } })),
			api(authClient.admin.listUserSessions({ userId })),
		]);
		return { user, sessions: sessions.sessions };
	});
	const data = result.data;
	const [copy, setCopy] = useState({ message: "", error: false });
	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between">
				<CardTitle>账户详情</CardTitle>
				<Button variant="ghost" size="sm" onClick={onClose}>
					收起
				</Button>
			</CardHeader>
			<CardContent className="space-y-5">
				<RequestState
					loading={result.loading}
					error={result.error}
					retry={result.reload}
				/>
				{data && (
					<>
						<div className="flex flex-wrap items-start justify-between gap-4">
							<div className="min-w-0 space-y-1">
								<p className="font-medium">{data.user.name}</p>
								<p className="break-all text-sm text-muted-foreground">
									{data.user.email}
								</p>
								<div className="flex flex-wrap items-center gap-2">
									<code className="break-all text-xs">{userId}</code>
									<Button
										variant="ghost"
										size="sm"
										onClick={async () => {
											try {
												await navigator.clipboard.writeText(userId);
												setCopy({ message: "用户 ID 已复制。", error: false });
											} catch {
												setCopy({
													message: "未能复制，请选中用户 ID 手动复制。",
													error: true,
												});
											}
										}}
									>
										复制 ID
									</Button>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => onEdit(data.user)}
								>
									编辑资料
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => onAction({ kind: "role", user: data.user })}
								>
									调整角色
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										onAction({
											kind: data.user.banned ? "unban" : "ban",
											user: data.user,
										})
									}
								>
									{data.user.banned ? "解除封禁" : "封禁用户"}
								</Button>
							</div>
						</div>
						<Notice
							message={copy.message}
							kind={copy.error ? "error" : "success"}
						/>
						<MonitorAttribution userId={userId} />
						{data.user.banned && (
							<div className="rounded-md border p-3 text-sm">
								<p className="font-medium">封禁原因</p>
								<p className="mt-1 break-words text-muted-foreground">
									{data.user.banReason || "未填写原因"}
								</p>
								<p className="mt-2 text-muted-foreground">
									解除时间：
									{data.user.banExpires
										? formatDate(data.user.banExpires)
										: "未设置"}
								</p>
							</div>
						)}
						<div>
							<h3 className="mb-3 text-sm font-medium">登录会话</h3>
							{data.sessions.length === 0 ? (
								<p className="py-4 text-sm text-muted-foreground">
									该用户当前没有登录会话。
								</p>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>设备与 IP</TableHead>
											<TableHead>到期时间</TableHead>
											<TableHead className="text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.sessions.map((session) => (
											<TableRow key={session.id}>
												<TableCell>
													<p className="max-w-md break-words text-sm">
														{session.userAgent || "未知设备"}
													</p>
													<p className="mt-1 text-xs text-muted-foreground">
														{session.ipAddress || "未记录 IP"}
													</p>
												</TableCell>
												<TableCell className="whitespace-nowrap">
													{formatDate(session.expiresAt)}
												</TableCell>
												<TableCell className="text-right">
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															onAction({
																kind: "revoke",
																user: data.user,
																session,
															})
														}
													>
														撤销会话
													</Button>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							)}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}

function UserEditor({
	user,
	onClose,
	onDone,
}: {
	user?: User;
	onClose: () => void;
	onDone: (message: string) => void;
}) {
	const [name, setName] = useState(user?.name ?? "");
	const [email, setEmail] = useState(user?.email ?? "");
	const [password, setPassword] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const [error, setError] = useState("");
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy.current) onClose();
			}}
		>
			<DialogContent className="max-h-[90dvh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{user ? "编辑用户" : "新建用户"}</DialogTitle>
					<DialogDescription>
						{user
							? "更新账户姓名和邮箱。变更会保存到当前用户。"
							: "创建普通用户账户。管理员权限需在创建后单独调整。"}
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy.current) return;
						busy.current = true;
						setPending(true);
						setError("");
						try {
							if (
								!user &&
								password &&
								(password.length < 12 || password.length > 128)
							)
								throw new Error("初始密码需为 12–128 个字符。");
							if (user)
								await api(
									authClient.admin.updateUser({
										userId: user.id,
										data: { name: name.trim(), email: email.trim() },
									}),
								);
							else
								await api(
									authClient.admin.createUser({
										name: name.trim(),
										email: email.trim(),
										role: "user",
										...(password ? { password } : {}),
									}),
								);
							onDone(user ? "用户资料已更新。" : "用户已创建。");
						} catch (cause) {
							setError(errorMessage(cause));
						} finally {
							busy.current = false;
							setPending(false);
						}
					}}
				>
					<fieldset disabled={pending} className="space-y-4">
						<Field label="姓名" htmlFor="user-edit-name">
							<Input
								id="user-edit-name"
								required
								maxLength={255}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</Field>
						<Field label="邮箱" htmlFor="user-edit-email">
							<Input
								id="user-edit-email"
								type="email"
								required
								value={email}
								onChange={(event) => setEmail(event.target.value)}
							/>
						</Field>
						{!user && (
							<Field
								label="初始密码（可选）"
								htmlFor="user-edit-password"
								hint="设置时需 12–128 个字符；留空时使用网站已有的其他登录方式。"
							>
								<Input
									id="user-edit-password"
									type="password"
									autoComplete="new-password"
									minLength={12}
									maxLength={128}
									value={password}
									onChange={(event) => setPassword(event.target.value)}
								/>
							</Field>
						)}
					</fieldset>
					<Notice message={error} />
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={pending}
							onClick={onClose}
						>
							取消
						</Button>
						<Button
							type="submit"
							disabled={pending || !name.trim() || !email.trim()}
						>
							{pending ? "保存中…" : user ? "保存修改" : "创建用户"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function UserAction({
	action,
	onClose,
	onDone,
}: {
	action: Action;
	onClose: () => void;
	onDone: (message: string) => void;
}) {
	const [reason, setReason] = useState("");
	const [role, setRole] = useState<"admin" | "user">(
		action.user.role === "admin" ? "user" : "admin",
	);
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const [error, setError] = useState("");
	const title = {
		ban: "封禁用户",
		unban: "解除封禁",
		role: "调整用户角色",
		revoke: "撤销登录会话",
	}[action.kind];
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy.current) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						请确认操作对象：{action.user.name}（{action.user.email}）。
					</DialogDescription>
				</DialogHeader>
				<form
					className="space-y-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (busy.current) return;
						busy.current = true;
						setPending(true);
						setError("");
						try {
							if (action.kind === "ban")
								await api(
									authClient.admin.banUser({
										userId: action.user.id,
										banReason: reason.trim(),
									}),
								);
							else if (action.kind === "unban")
								await api(
									authClient.admin.unbanUser({ userId: action.user.id }),
								);
							else if (action.kind === "role")
								await api(
									authClient.admin.setRole({ userId: action.user.id, role }),
								);
							else if (action.kind === "revoke")
								await api(
									authClient.admin.revokeUserSession({
										sessionToken: action.session.token,
									}),
								);
							onDone(`${title}已完成。`);
						} catch (cause) {
							setError(errorMessage(cause));
						} finally {
							busy.current = false;
							setPending(false);
						}
					}}
				>
					<fieldset disabled={pending} className="space-y-4">
						{action.kind === "ban" && (
							<>
								<p className="text-sm text-muted-foreground">
									封禁后该用户无法登录，已有会话将被撤销。
								</p>
								<Field label="封禁原因" htmlFor="user-ban-reason">
									<Textarea
										id="user-ban-reason"
										required
										maxLength={500}
										value={reason}
										onChange={(event) => setReason(event.target.value)}
									/>
								</Field>
							</>
						)}
						{action.kind === "unban" && (
							<p className="text-sm text-muted-foreground">
								原封禁原因：{action.user.banReason || "未填写"}
								。确认后该账户可重新登录。
							</p>
						)}
						{action.kind === "role" && (
							<>
								<Field label="新角色" htmlFor="user-role">
									<select
										id="user-role"
										className={selectClassName}
										value={role}
										onChange={(event) =>
											setRole(event.target.value === "admin" ? "admin" : "user")
										}
									>
										<option value="user">普通用户（user）</option>
										<option value="admin">管理员（admin）</option>
									</select>
								</Field>
								<p className="text-sm text-muted-foreground">
									将替换现有角色「{action.user.role || "user"}
									」。管理员可管理用户与业务数据。
								</p>
							</>
						)}
						{action.kind === "revoke" && (
							<p className="text-sm text-muted-foreground">
								这台设备将退出登录。设备：
								{action.session.userAgent || "未知设备"}；IP：
								{action.session.ipAddress || "未记录"}。
							</p>
						)}
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
							variant={
								action.kind === "ban" || action.kind === "revoke"
									? "destructive"
									: "default"
							}
							disabled={pending || (action.kind === "ban" && !reason.trim())}
						>
							{pending ? "处理中…" : `确认${title}`}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
