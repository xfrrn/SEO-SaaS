"use client";

import { useState } from "react";
import { Login } from "@/components/dashboard-page";
import { Notice, RequestState } from "@/components/shared";
import { TicketsPanel } from "@/components/tickets-panel";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export function FeedbackPage({
	googleEnabled,
	oauthError,
}: {
	googleEnabled: boolean;
	oauthError: string;
}) {
	const session = authClient.useSession();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function signOut() {
		setBusy(true);
		setError("");
		try {
			await api(authClient.signOut());
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}
	if (session.isPending || session.error)
		return (
			<main className="mx-auto max-w-xl p-6 pt-24">
				<RequestState
					loading={session.isPending}
					error={session.error ? "无法连接反馈服务，请重试。" : ""}
					retry={() => void session.refetch()}
				/>
			</main>
		);
	if (!session.data)
		return (
			<Login customer googleEnabled={googleEnabled} oauthError={oauthError} />
		);
	return (
		<main className="mx-auto min-h-screen max-w-6xl space-y-6 p-4 md:p-8">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-2xl font-bold">反馈中心</h1>
					<p className="mt-1 break-all text-sm text-muted-foreground">
						{session.data.user.email}
					</p>
				</div>
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void signOut()}
				>
					退出登录
				</Button>
			</header>
			<Notice message={error} />
			<TicketsPanel key={session.data.user.id} />
		</main>
	);
}
