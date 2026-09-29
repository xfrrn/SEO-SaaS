"use client";

import { useCallback, useEffect, useState } from "react";
import { authClient } from "../../lib/auth-client";

type Subscriptions = NonNullable<
	Awaited<ReturnType<typeof authClient.subscription.list>>["data"]
>;

export default function BillingPage() {
	const { data: session, isPending, error: sessionError } = authClient.useSession();
	const [subscriptions, setSubscriptions] = useState<Subscriptions>([]);
	const [plan, setPlan] = useState("basic");
	const [annual, setAnnual] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const current = subscriptions[0];

	const refresh = useCallback(async () => {
		const { data, error } = await authClient.subscription.list();
		if (error) throw new Error(error.message ?? "无法读取订阅");
		setSubscriptions(data ?? []);
		return data ?? [];
	}, []);

	useEffect(() => {
		if (session) {
			void refresh().catch(() => setMessage("无法读取订阅，请点击刷新重试。"));
		} else {
			setSubscriptions([]);
		}
	}, [session, refresh]);

	async function run(action: () => Promise<unknown>) {
		setPending(true);
		setMessage("");
		try {
			await action();
			await refresh();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "请求失败，请重试。");
		} finally {
			setPending(false);
		}
	}

	async function upgrade() {
		// 每次操作先读取有效订阅；读取失败时停止，避免重复购买。
		const [active] = await refresh();
		if (active && !active.stripeSubscriptionId) {
			throw new Error("订阅尚未同步完成，请稍后刷新重试。");
		}
		const { error } = await authClient.subscription.upgrade({
			plan,
			annual,
			subscriptionId: active?.stripeSubscriptionId,
			successUrl: "/billing",
			cancelUrl: "/billing",
			returnUrl: "/billing",
		});
		if (error) throw new Error(error.message ?? "订阅操作失败");
	}

	async function cancel() {
		if (!current?.stripeSubscriptionId) throw new Error("请先刷新订阅。");
		const { error } = await authClient.subscription.cancel({
			subscriptionId: current.stripeSubscriptionId,
			returnUrl: "/billing",
		});
		if (error) throw new Error(error.message ?? "无法取消订阅");
	}

	async function restore() {
		if (!current?.stripeSubscriptionId) throw new Error("请先刷新订阅。");
		const { error } = await authClient.subscription.restore({
			subscriptionId: current.stripeSubscriptionId,
		});
		if (error) throw new Error(error.message ?? "无法恢复订阅");
	}

	async function portal() {
		const { error } = await authClient.subscription.billingPortal({
			returnUrl: "/billing",
		});
		if (error) throw new Error(error.message ?? "无法打开账单管理");
	}

	if (isPending) return <p>正在读取登录状态…</p>;
	if (sessionError) return <p role="alert">{sessionError.message}</p>;
	if (!session) return <a href="/">请先登录</a>;

	return (
		<>
			<h1>个人订阅</h1>
			<p>
				<a href="/">返回账户</a>
			</p>
			{current ? (
				<p>
					当前套餐：{current.plan}（
					{current.billingInterval === "year" ? "年付" : "月付"}），状态：
					{current.status}。
					{(current.cancelAtPeriodEnd || current.cancelAt) &&
						"已预约取消，到期前仍可使用。"}
				</p>
			) : (
				<p>暂无有效订阅。</p>
			)}
			<fieldset disabled={pending}>
				<legend>选择套餐</legend>
				<label htmlFor="plan">套餐 </label>
				<select
					id="plan"
					value={plan}
					onChange={(event) => setPlan(event.target.value)}
				>
					<option value="basic">Basic</option>
					<option value="pro">Pro</option>
				</select>{" "}
				<label>
					<input
						type="checkbox"
						checked={annual}
						onChange={(event) => setAnnual(event.target.checked)}
					/>
					年付（取消勾选为月付）
				</label>
				<p>价格以 Stripe 结算页面为准；切换套餐默认立即生效并按比例计费。</p>
				<button type="button" onClick={() => void run(upgrade)}>
					{current ? "切换套餐 / 付款周期" : "订阅"}
				</button>
			</fieldset>
			<p>
				<button type="button" disabled={pending} onClick={() => void run(refresh)}>
					刷新订阅
				</button>{" "}
				<button
					type="button"
					disabled={pending || !current?.stripeSubscriptionId}
					onClick={() => void run(cancel)}
				>
					取消订阅
				</button>{" "}
				<button
					type="button"
					disabled={
						pending ||
						!current?.stripeSubscriptionId ||
						!(current.cancelAtPeriodEnd || current.cancelAt || current.stripeScheduleId)
					}
					onClick={() => void run(restore)}
				>
					撤销待生效的取消 / 套餐变更
				</button>{" "}
				<button type="button" disabled={pending} onClick={() => void run(portal)}>
					管理账单和支付方式
				</button>
			</p>
			<p>取消操作会进入 Stripe 门户确认。已经结束的订阅需要重新购买。</p>
			<p>支付返回此页后请刷新；实际访问权限由服务端同步的订阅决定。</p>
			<p>
				<a href="/api/premium">验证服务端付费权限</a>
			</p>
			<p role="status">{pending ? "正在处理…" : message}</p>
		</>
	);
}
