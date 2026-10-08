"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { authClient } from "../../../lib/auth-client";

export default function PaymentReturn() {
	const [message, setMessage] = useState(
		"返回此页面不代表付款已完成，请查询订单结果。",
	);
	const [pending, setPending] = useState(false);
	async function complete() {
		const orderId = new URL(window.location.href).searchParams.get("orderId");
		if (!orderId) {
			setMessage("缺少订单编号，请从网站的订单列表查询。");
			return;
		}
		setPending(true);
		try {
			const result = await authClient.business.orders.complete({ orderId });
			if (result.error) {
				setMessage(
					result.error.status === 401
						? "请先在网站登录购买时使用的账号，再返回此页查询。"
						: "尚未确认付款或权益仍在处理中，请稍后重试。请勿重复付款。",
				);
			} else
				setMessage(
					result.data.status === "fulfilled"
						? "付款已确认，购买的权益已到账。"
						: "订单已更新，请到网站的订单列表查看详情。",
				);
		} catch {
			setMessage("暂时无法查询，请稍后重试。请勿重复付款。");
		} finally {
			setPending(false);
		}
	}
	return (
		<main className="container flex min-h-screen items-center justify-center py-10">
			<Card className="w-full max-w-lg">
				<CardHeader>
					<CardTitle>购买结果</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					<p role="status" className="text-sm text-muted-foreground">
						{message}
					</p>
					<Button onClick={complete} disabled={pending}>
						{pending ? "正在查询…" : "查询付款结果"}
					</Button>
				</CardContent>
			</Card>
		</main>
	);
}
