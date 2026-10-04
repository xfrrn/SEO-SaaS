"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function PayPalPage() {
	const { data: session, isPending, error } = authClient.useSession();
	const [paymentId, setPaymentId] = useState("");
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const [canRestart, setCanRestart] = useState(false);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setPaymentId(params.get("payment") ?? "");
		if (params.get("cancelled"))
			setMessage("付款已取消，可重新进入 PayPal。尚未授予付费权限。");
	}, []);

	async function run(capture: boolean) {
		if (!session) return;
		setPending(true);
		setMessage("");
		try {
			// 按用户保存重试键，避免网络失败或刷新页面后重复创建订单。
			const key = `paypal-payment:${session.user.id}`;
			const id =
				paymentId || sessionStorage.getItem(key) || crypto.randomUUID();
			sessionStorage.setItem(key, id);
			setPaymentId(id);
			const response = await fetch(
				`/api/paypal/${capture ? "capture" : "orders"}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ paymentId: id }),
				},
			);
			const result = (await response.json()) as {
				error?: string;
				status?: string;
				approvalURL?: string;
			};
			if (!response.ok) throw new Error(result.error ?? "支付请求失败");
			if (!capture && result.approvalURL) {
				window.location.assign(result.approvalURL);
				return;
			}
			if (result.status === "paid")
				setMessage("付款已完成，可以访问已购内容。");
			else if (
				["refunded", "reversed", "denied"].includes(result.status ?? "")
			) {
				setMessage("付款已退款、撤销或失败，没有付费权限。");
				sessionStorage.removeItem(key);
				setCanRestart(true);
			} else
				setMessage(
					"付款尚未完成。请先在 PayPal 批准，再点击确认或刷新付款状态。",
				);
		} catch (cause) {
			setMessage(cause instanceof Error ? cause.message : "请求失败，请重试。");
		} finally {
			setPending(false);
		}
	}

	if (isPending) return <p>正在读取登录状态…</p>;
	if (error) return <p role="alert">{error.message}</p>;
	if (!session) return <a href="/">请先登录</a>;
	return (
		<>
			<h1>PayPal 一次性付款</h1>
			<p>
				<a href="/">返回账户</a>
			</p>
			<p>
				购买数字内容访问权限。应付价格以 PayPal 结算页面为准；没有自动续费。
			</p>
			<button type="button" disabled={pending} onClick={() => void run(false)}>
				前往 PayPal 付款
			</button>{" "}
			<button
				type="button"
				disabled={pending || !paymentId}
				onClick={() => void run(true)}
			>
				确认 / 刷新付款状态
			</button>
			{canRestart && (
				<p>
					<button
						type="button"
						disabled={pending}
						onClick={() => {
							sessionStorage.removeItem(`paypal-payment:${session.user.id}`);
							setPaymentId("");
							setCanRestart(false);
							setMessage("已准备新订单，请点击前往 PayPal 付款。");
							window.history.replaceState(null, "", "/paypal");
						}}
					>
						重新购买
					</button>
				</p>
			)}
			<p>
				从 PayPal 返回后点击确认。跳转成功本身不表示到账；待处理付款请稍后刷新。
			</p>
			<p>
				<a href="/api/paypal/access">验证已购内容访问权限</a>
			</p>
			<p role="status">{pending ? "正在处理…" : message}</p>
		</>
	);
}
