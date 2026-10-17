import { FeedbackPage } from "@/components/feedback-page";
import { readGoogleConfig } from "@/lib/auth-config";

export const dynamic = "force-dynamic";

export default async function SupportPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { error } = await searchParams;
	return (
		<FeedbackPage
			googleEnabled={!!readGoogleConfig()}
			oauthError={
				typeof error === "string"
					? "Google 登录未完成，请重试或使用邮箱密码登录。"
					: ""
			}
		/>
	);
}
