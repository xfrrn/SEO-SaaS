import { toNextJsHandler } from "@app/auth-sdk/next-js";
import { getAuth } from "../../../../lib/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = toNextJsHandler(async (request: Request) => {
	try {
		return await getAuth().handler(request);
	} catch {
		// Never return database URLs, passwords, stack traces, or provider error bodies.
		console.error(
			"[dashboard-auth] Authentication unavailable. Check server configuration, migrations, and database connectivity.",
		);
		return Response.json(
			{
				code: "DASHBOARD_UNAVAILABLE",
				message:
					"后台服务尚未配置或暂时不可用，请联系管理员检查初始化与数据库。",
			},
			{ status: 503, headers: { "Cache-Control": "no-store" } },
		);
	}
});

export const GET = handlers.GET;
export const POST = handlers.POST;
