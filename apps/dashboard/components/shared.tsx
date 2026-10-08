"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	children: ReactNode;
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

export function Notice({
	message,
	kind = "error",
}: {
	message: string;
	kind?: "error" | "success";
}) {
	if (!message) return null;
	return (
		<p
			role={kind === "error" ? "alert" : "status"}
			className={`rounded-md border p-3 text-sm ${kind === "error" ? "border-destructive/30 text-destructive" : "text-foreground"}`}
		>
			{message}
		</p>
	);
}

export function RequestState({
	loading,
	error,
	retry,
	empty = false,
	message = "暂无记录。",
}: {
	loading: boolean;
	error: string;
	retry: () => void;
	empty?: boolean;
	message?: string;
}) {
	if (loading)
		return (
			<div role="status" aria-label="正在加载" className="space-y-3 py-6">
				{[0, 1, 2].map((row) => (
					<div
						key={row}
						className="h-10 animate-pulse rounded bg-muted motion-reduce:animate-none"
					/>
				))}
			</div>
		);
	if (error)
		return (
			<div className="space-y-3 py-6">
				<Notice message={error} />
				<Button type="button" variant="outline" onClick={retry}>
					重新加载
				</Button>
			</div>
		);
	if (empty)
		return (
			<p className="py-12 text-center text-sm text-muted-foreground">
				{message}
			</p>
		);
	return null;
}

export function Pagination({
	offset,
	limit,
	total,
	hasMore,
	onChange,
}: {
	offset: number;
	limit: number;
	total?: number;
	hasMore?: boolean;
	onChange: (offset: number) => void;
}) {
	return (
		<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
			<p>
				{total === undefined
					? `第 ${Math.floor(offset / limit) + 1} 页`
					: `共 ${total.toLocaleString()} 条 · 第 ${Math.floor(offset / limit) + 1} 页`}
			</p>
			<div className="flex gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={offset === 0}
					onClick={() => onChange(Math.max(0, offset - limit))}
				>
					上一页
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={
						hasMore === undefined ? offset + limit >= (total ?? 0) : !hasMore
					}
					onClick={() => onChange(offset + limit)}
				>
					下一页
				</Button>
			</div>
		</div>
	);
}
