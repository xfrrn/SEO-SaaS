"use client";

import { LogOut, Moon, RefreshCw, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import type { FormEvent } from "react";
import { useState } from "react";
import { AuditPanel } from "@/components/audit-panel";
import { CreditsPanel } from "@/components/credits-panel";
import { MembershipsPanel } from "@/components/memberships-panel";
import { MonitorPanel } from "@/components/monitor-panel";
import { OrdersPanel } from "@/components/orders-panel";
import { Overview } from "@/components/overview";
import { ProductsPanel } from "@/components/products-panel";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersPanel } from "@/components/users-panel";
import { api, errorMessage, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

function Login() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		setBusy(true);
		setError("");
		try {
			await api(
				authClient.signIn.email({
					email: String(form.get("email")),
					password: String(form.get("password")),
					rememberMe: false,
				}),
			);
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<main className="flex min-h-screen items-center justify-center p-4">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle className="text-2xl">登录管理后台</CardTitle>
					<CardDescription>使用网站管理员账号继续。</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="space-y-5" onSubmit={submit}>
						<Field label="邮箱" htmlFor="login-email">
							<Input
								id="login-email"
								name="email"
								type="email"
								autoComplete="username"
								required
								autoFocus
							/>
						</Field>
						<Field label="密码" htmlFor="login-password">
							<Input
								id="login-password"
								name="password"
								type="password"
								autoComplete="current-password"
								required
							/>
						</Field>
						<Notice message={error} />
						<Button className="w-full" type="submit" disabled={busy}>
							{busy ? "正在登录…" : "登录"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}

function Workspace({ email }: { email: string }) {
	const permission = useResource("permission", () =>
		api(authClient.business.admin.overview()),
	);
	const [tab, setTab] = useState("overview");
	const [refresh, setRefresh] = useState(0);
	const [error, setError] = useState("");
	const [signingOut, setSigningOut] = useState(false);
	const { resolvedTheme, setTheme } = useTheme();
	async function signOut() {
		setSigningOut(true);
		setError("");
		try {
			await api(authClient.signOut());
		} catch (error) {
			setError(errorMessage(error));
		} finally {
			setSigningOut(false);
		}
	}
	if (!permission.data)
		return (
			<main className="mx-auto max-w-xl p-6 pt-24">
				<Card>
					<CardHeader>
						<CardTitle>后台访问</CardTitle>
						<CardDescription>{email}</CardDescription>
					</CardHeader>
					<CardContent>
						<RequestState
							loading={permission.loading}
							error={permission.error}
							retry={permission.reload}
						/>
						<Button
							variant="outline"
							onClick={() => void signOut()}
							disabled={signingOut}
						>
							退出并切换账号
						</Button>
						<Notice message={error} />
					</CardContent>
				</Card>
			</main>
		);
	return (
		<div className="flex min-h-screen w-full flex-col">
			<a
				href="#dashboard-main"
				className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3"
			>
				跳到主要内容
			</a>
			<main
				id="dashboard-main"
				className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:gap-8 md:p-8"
			>
				<header className="flex flex-wrap items-center justify-between gap-4">
					<div>
						<h1 className="text-2xl font-bold tracking-tight">管理后台</h1>
						<p className="mt-1 break-all text-sm text-muted-foreground">
							{email}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="icon"
							aria-label="切换明暗主题"
							onClick={() =>
								setTheme(resolvedTheme === "dark" ? "light" : "dark")
							}
						>
							<Sun className="h-4 w-4 dark:hidden" />
							<Moon className="hidden h-4 w-4 dark:block" />
						</Button>
						<Button
							variant="outline"
							onClick={() => setRefresh((value) => value + 1)}
						>
							<RefreshCw className="mr-2 h-4 w-4" />
							刷新
						</Button>
						<Button
							variant="outline"
							onClick={() => void signOut()}
							disabled={signingOut}
						>
							<LogOut className="mr-2 h-4 w-4" />
							退出
						</Button>
					</div>
				</header>
				<Notice message={error} />
				<Tabs value={tab} onValueChange={setTab} className="min-w-0 space-y-4">
					<div className="overflow-x-auto pb-1">
						<TabsList aria-label="后台模块">
							{[
								["overview", "概览"],
								["users", "用户"],
								["products", "套餐"],
								["orders", "订单"],
								["memberships", "会员"],
								["credits", "积分"],
								["audit", "审计"],
								["monitor", "监控"],
							].map(([value, label]) => (
								<TabsTrigger key={value} value={value!}>
									{label}
								</TabsTrigger>
							))}
						</TabsList>
					</div>
					<TabsContent value="overview">
						<Overview key={refresh} onOpenOrders={() => setTab("orders")} />
					</TabsContent>
					<TabsContent value="users">
						<UsersPanel key={refresh} />
					</TabsContent>
					<TabsContent value="products">
						<ProductsPanel key={refresh} />
					</TabsContent>
					<TabsContent value="orders">
						<OrdersPanel key={refresh} />
					</TabsContent>
					<TabsContent value="memberships">
						<MembershipsPanel key={refresh} />
					</TabsContent>
					<TabsContent value="credits">
						<CreditsPanel key={refresh} />
					</TabsContent>
					<TabsContent value="audit">
						<AuditPanel key={refresh} />
					</TabsContent>
					<TabsContent value="monitor">
						<MonitorPanel key={refresh} />
					</TabsContent>
				</Tabs>
			</main>
		</div>
	);
}

export default function DashboardPage() {
	const session = authClient.useSession();
	if (session.isPending)
		return (
			<main className="mx-auto max-w-xl p-6 pt-24">
				<RequestState loading error="" retry={() => {}} />
			</main>
		);
	if (session.error)
		return (
			<main className="mx-auto max-w-xl p-6 pt-24">
				<Card>
					<CardHeader>
						<CardTitle>暂时无法连接后台</CardTitle>
						<CardDescription>
							请确认网站后台已启动并完成初始化，然后重新连接。
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button onClick={() => void session.refetch()}>重新连接</Button>
					</CardContent>
				</Card>
			</main>
		);
	return session.data ? (
		<Workspace key={session.data.session.id} email={session.data.user.email} />
	) : (
		<Login />
	);
}
