"use client";

import { PaymentTotalsTable } from "@/components/payment-totals";
import { RequestState } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { api, useResource } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { formatDate } from "@/lib/format";

export function CustomerSpending({ userId }: { userId: string }) {
	const resource = useResource(userId, () =>
		api(authClient.business.admin.spending({ query: { referenceId: userId } })),
	);
	const value = resource.data;
	return (
		<section className="space-y-3 border-t pt-5" aria-label="用户累计消费">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="text-sm font-semibold">累计消费</h3>
				<Button
					variant="outline"
					size="sm"
					onClick={resource.reload}
					disabled={resource.loading}
				>
					刷新消费
				</Button>
			</div>
			<RequestState
				{...resource}
				retry={resource.reload}
				empty={value?.paidOrders === 0}
				message="该用户尚无已核验付款。"
			/>
			{value && value.paidOrders > 0 && (
				<>
					<p className="text-sm text-muted-foreground">
						共 {value.paidOrders} 笔付款 · 首次 {formatDate(value.firstPaidAt)}{" "}
						· 最近 {formatDate(value.lastPaidAt)}
					</p>
					<PaymentTotalsTable rows={value.currencies} />
					<p className="text-xs text-muted-foreground">
						累计历史收款按币种展示，净额扣除这些订单当前已记录的退款。
					</p>
				</>
			)}
		</section>
	);
}
