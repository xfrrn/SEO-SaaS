"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { authClient } from "../lib/auth-client";

export default function Home() {
	const { data: session, isPending, error: sessionError } = authClient.useSession();
	const [isSignUp, setIsSignUp] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const email = String(form.get("email") ?? "");
		const password = String(form.get("password") ?? "");
		setPending(true);
		setMessage("");
		try {
			const result = isSignUp
				? await authClient.signUp.email({
						name: String(form.get("name") ?? ""),
						email,
						password,
					})
				: await authClient.signIn.email({ email, password });
			setMessage(result.error?.message ?? "登录成功");
		} catch {
			setMessage("网络请求失败，请重试。");
		} finally {
			setPending(false);
		}
	}

	async function signOut() {
		setPending(true);
		setMessage("");
		try {
			const { error } = await authClient.signOut();
			setMessage(error?.message ?? "已退出登录");
		} catch {
			setMessage("退出失败，请重试。");
		} finally {
			setPending(false);
		}
	}

	return (
		<>
			<h1>账户</h1>
			{isPending ? (
				<p>正在读取登录状态…</p>
			) : session ? (
				<>
					<p>已登录：{session.user.email}</p>
					<button type="button" disabled={pending} onClick={signOut}>
						退出登录
					</button>
				</>
			) : (
				<form onSubmit={submit}>
					<fieldset disabled={pending}>
						<legend>{isSignUp ? "注册" : "登录"}</legend>
						{isSignUp && (
							<p>
								<label htmlFor="name">姓名 </label>
								<input id="name" name="name" autoComplete="name" required />
							</p>
						)}
						<p>
							<label htmlFor="email">邮箱 </label>
							<input
								id="email"
								name="email"
								type="email"
								autoComplete="email"
								required
							/>
						</p>
						<p>
							<label htmlFor="password">密码 </label>
							<input
								id="password"
								name="password"
								type="password"
								autoComplete={isSignUp ? "new-password" : "current-password"}
								minLength={8}
								required
							/>
						</p>
						<button type="submit">{isSignUp ? "创建账户" : "登录"}</button>{" "}
						<button type="button" onClick={() => setIsSignUp(!isSignUp)}>
							{isSignUp ? "已有账户，去登录" : "没有账户，去注册"}
						</button>
					</fieldset>
				</form>
			)}
			<p role="status">{sessionError?.message ?? message}</p>
		</>
	);
}
