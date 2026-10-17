import DashboardPage from "@/components/dashboard-page";
import { readGoogleConfig } from "@/lib/auth-config";

export const dynamic = "force-dynamic";

const oauthErrors = new Map([
	["access_denied", "已取消 Google 授权，可以重试或使用邮箱密码登录。"],
	[
		"account_not_linked",
		"此邮箱尚未关联 Google。请先使用邮箱密码登录，再点击“绑定 Google 账号”。",
	],
	["email_does_not_match", "请使用与当前账号邮箱一致的 Google 账号进行绑定。"],
	[
		"account_already_linked_to_different_user",
		"此 Google 账号已绑定其他用户，请切换账号。",
	],
]);

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { error } = await searchParams;
	return (
		<DashboardPage
			googleEnabled={!!readGoogleConfig()}
			oauthError={
				typeof error === "string"
					? (oauthErrors.get(error) ??
						"Google 认证未完成，请重试；持续失败时请联系管理员检查登录配置。")
					: ""
			}
		/>
	);
}
