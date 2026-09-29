import { auth } from "../../../lib/auth";

export const runtime = "nodejs";

/** 服务端保护付费接口：仅信任会话和数据库中同步的订阅。 */
export async function GET(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session) {
		return Response.json({ error: "请先登录" }, { status: 401 });
	}

	const subscriptions = await auth.api.listActiveSubscriptions({
		headers: request.headers,
	});
	const paid = subscriptions.some(
		(subscription) =>
			subscription.referenceId === session.user.id &&
			(subscription.plan === "basic" || subscription.plan === "pro") &&
			(subscription.status === "active" || subscription.status === "trialing"),
	);
	if (!paid) {
		return Response.json({ error: "需要有效的个人订阅" }, { status: 403 });
	}

	return Response.json({ message: "可以在这里执行需要订阅的业务操作。" });
}
